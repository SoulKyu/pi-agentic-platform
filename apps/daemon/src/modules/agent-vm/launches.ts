import { randomUUID } from "node:crypto";
import {
  boxKey,
  type BoxRef,
  LAUNCH_LIMITS,
  LAUNCH_STEP_LIMITS_MS,
  LAUNCH_STEPS,
  type LaunchesStreamEvent,
  type LaunchDetail,
  type LaunchStep,
  type LaunchStepState,
  type LaunchView,
  type Waiting,
} from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { LaunchHandle, LaunchRegistry } from "../../kernel/launches.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import { stoppableSteps } from "./launch-stop.ts";
import { createLaunchStepStore, type LaunchStepStore } from "./launch-steps.ts";

/** A launch publishes at most once a second, plus every step state change. */
export const LAUNCH_EVERY_MS = 1000;
/** A launch that outlives every step at its limit is forgotten, not slow. */
export const LAUNCH_MAX_MS = Object.values(LAUNCH_STEP_LIMITS_MS).reduce((sum, ms) => sum + ms, 0);
const NO_HELPERS = { active: 0, max: 0, waiting: 0 } as const;

export interface LaunchRegistryDeps {
  readonly clock: Pick<Clock, "now" | "setTimeout" | "clearTimeout">;
  readonly logger: Pick<Logger, "warn">;
  /** Absent (tests): launches are not published and no step time is kept. */
  readonly hub?: Pick<StreamHub, "publish" | "registerSnapshot" | "hasSubscribers">;
  readonly db?: Db;
  /** R13: the box has no VM but the one this launch serves (an isolated task VM or another entry makes Stop unsafe). Absent: it has none. */
  readonly soleVm?: (box: BoxRef) => boolean;
  /** The install-wide Pi helper counts of a snapshot; task A6 binds the real ones. */
  readonly helpers?: () => { readonly active: number; readonly max: number; readonly waiting: number };
}

interface StepRecord {
  state: LaunchStepState;
  startedAt: number | null;
  endedAt: number | null;
  usualMs: number | null;
  deadlineAt: number | null;
  detail: LaunchDetail | null;
  code: string | undefined;
}

interface LaunchRecord {
  readonly id: string;
  readonly box: BoxRef;
  readonly owner: string;
  for: string;
  readonly startedAt: number;
  readonly steps: Map<LaunchStep, StepRecord>;
  waiting: Waiting | undefined;
  refs: number;
  ok: boolean;
  code: string | undefined;
  ended: boolean;
  stopped: boolean;
  /** The watchdog: closes the launch if nobody ever ends it. */
  watchdog: TimerHandle | null;
  lastSent: number;
  timer: TimerHandle | null;
}

const emptyStep = (): StepRecord => ({
  state: "pending",
  startedAt: null,
  endedAt: null,
  usualMs: null,
  deadlineAt: null,
  detail: null,
  code: undefined,
});

/**
 * The live launches (spec launch progress), in memory: one per box, published on the owner's `launches` channel. Ids are minted
 * here. A step that ends well is kept in `launch_steps`, whose median is the "usual" of the next run.
 */
export function createLaunchRegistry(deps: LaunchRegistryDeps): LaunchRegistry {
  const { clock, hub } = deps;
  const store: LaunchStepStore | null = deps.db ? createLaunchStepStore(deps.db) : null;
  const byBox = new Map<string, LaunchRecord>();
  const listeners = new Set<(box: BoxRef) => void>();
  /** Owners ever seen on the channel; never pruned, because a quick reconnect replays without asking for a snapshot. */
  const seenOwners = new Set<string>();

  function viewOf(record: LaunchRecord): LaunchView {
    const steps = LAUNCH_STEPS.filter((step) => record.steps.has(step)).map((step) => {
      const s = record.steps.get(step) as StepRecord;
      return {
        step,
        state: s.state,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        usualMs: s.usualMs,
        deadlineAt: s.deadlineAt,
        detail: s.detail,
        ...(s.code === undefined ? {} : { code: s.code }),
      };
    });
    return {
      id: record.id,
      box: record.box,
      for: record.for,
      startedAt: record.startedAt,
      steps,
      ...(record.waiting === undefined ? {} : { waiting: record.waiting }),
      ...(stoppableNow({ steps }, record.box) ? { stoppable: true } : {}),
    };
  }

  function stoppableNow(view: Pick<LaunchView, "steps">, box: BoxRef): boolean {
    if (!stoppableSteps(view)) return false;
    try {
      return deps.soleVm?.(box) ?? true;
    } catch (error) {
      deps.logger.warn("launch_sole_vm_failed", { err: error });
      return false;
    }
  }

  function publish(owner: string, event: LaunchesStreamEvent): void {
    seenOwners.add(owner);
    if (!hub) return;
    try {
      hub.publish("launches", owner, event);
    } catch (error) {
      deps.logger.warn("launch_publish_failed", { err: error });
    }
  }

  function tell(box: BoxRef): void {
    for (const listener of [...listeners]) {
      try {
        listener(box);
      } catch (error) {
        deps.logger.warn("launch_listener_failed", { err: error });
      }
    }
  }

  function flush(record: LaunchRecord): void {
    if (record.timer !== null) clock.clearTimeout(record.timer);
    record.timer = null;
    record.lastSent = clock.now();
    publish(record.owner, { kind: "launch", launch: viewOf(record) });
  }

  /** A state change goes out at once; anything else waits for the second that has not passed. */
  function emit(record: LaunchRecord, immediate: boolean): void {
    if (record.ended) return;
    if (immediate) {
      flush(record);
      tell(record.box);
      return;
    }
    const due = record.lastSent + LAUNCH_EVERY_MS;
    if (clock.now() >= due) return flush(record);
    record.timer ??= clock.setTimeout(() => {
      record.timer = null;
      if (!record.ended) flush(record);
    }, due - clock.now());
  }

  function setStep(
    record: LaunchRecord,
    step: LaunchStep,
    state: LaunchStepState,
    detail?: LaunchDetail,
  ): void {
    if (record.ended) return;
    const s = record.steps.get(step) ?? emptyStep();
    // A step only moves forward (a joined opener re-reports what is finished): nothing changes once it is terminal.
    if (s.state === "done" || s.state === "skipped" || s.state === "failed") return;
    record.steps.set(step, s);
    const changed = s.state !== state;
    const now = clock.now();
    if (changed) {
      s.state = state;
      if (state === "running") {
        s.startedAt = now;
        s.endedAt = null;
        s.deadlineAt = now + LAUNCH_STEP_LIMITS_MS[step];
        s.usualMs = readUsual(record.box, step);
      } else if (state !== "pending") {
        s.endedAt = now;
        if (state === "done" && s.startedAt !== null) writeSample(record.box, step, now - s.startedAt, now);
      }
    }
    if (detail) s.detail = { line: detail.line.slice(0, LAUNCH_LIMITS.lineChars), at: detail.at };
    if (changed || detail) emit(record, changed);
  }

  function readUsual(box: BoxRef, step: LaunchStep): number | null {
    try {
      return store?.usualMs(boxKey(box), step) ?? null;
    } catch (error) {
      deps.logger.warn("launch_steps_read_failed", { err: error });
      return null;
    }
  }

  function writeSample(box: BoxRef, step: LaunchStep, ms: number, at: number): void {
    try {
      store?.record(boxKey(box), step, ms, at);
    } catch (error) {
      deps.logger.warn("launch_steps_write_failed", { err: error });
    }
  }

  function failRunning(record: LaunchRecord, code: string | undefined): void {
    for (const s of record.steps.values())
      if (s.state === "running") {
        s.state = "failed";
        s.endedAt = clock.now();
        s.code = code;
      }
  }

  function finish(record: LaunchRecord): void {
    record.ended = true;
    if (record.watchdog !== null) clock.clearTimeout(record.watchdog);
    record.watchdog = null;
    // The last throttled `launch` is dropped, not flushed: nothing may follow its own `end` (the web reducer has no tombstone).
    if (record.timer !== null) clock.clearTimeout(record.timer);
    record.timer = null;
    if (byBox.get(boxKey(record.box)) === record) byBox.delete(boxKey(record.box));
    publish(record.owner, {
      kind: "end",
      id: record.id,
      done: true,
      ok: record.ok,
      ...(record.code === undefined ? {} : { code: record.code }),
    });
    tell(record.box);
  }

  function handleOf(record: LaunchRecord, owning: boolean): LaunchHandle {
    let over = false;
    return {
      id: record.id,
      step: (step, state, detail) => setStep(record, step, state, detail),
      wait(waiting) {
        if (record.ended) return;
        const reasonChanged = record.waiting?.reason !== waiting?.reason;
        record.waiting = waiting ?? undefined;
        emit(record, reasonChanged);
      },
      stopped: () => record.stopped,
      end(ok, code) {
        if (!owning || over || record.ended) return;
        over = true;
        record.refs -= 1;
        // An earlier handle's failure stays with its own caller: the last handle's outcome is the launch's.
        if (record.refs > 0) return;
        record.ok = ok;
        record.code = ok ? undefined : code;
        if (!ok) failRunning(record, code);
        finish(record);
      },
    };
  }

  const live = (owner: string): LaunchView[] =>
    [...byBox.values()]
      .filter((record) => record.owner === owner)
      .slice(0, LAUNCH_LIMITS.launches)
      .map(viewOf);

  hub?.registerSnapshot("launches", (owner) => {
    seenOwners.add(owner);
    return {
      kind: "snapshot",
      launches: live(owner),
      helpers: deps.helpers?.() ?? NO_HELPERS,
    } satisfies LaunchesStreamEvent;
  });

  return {
    open({ box, owner, for: reason }) {
      const key = boxKey(box);
      const joined = byBox.get(key);
      if (joined) {
        joined.refs += 1;
        // A start joining a build launch makes it a box launch (R15): the box reads `starting` and the title follows.
        if (joined.for === "rebuild" && reason !== "rebuild") {
          joined.for = reason;
          emit(joined, true);
        }
        return handleOf(joined, true);
      }
      const now = clock.now();
      // A build launch (a Rebuild, R15) has the image step alone: nothing else of a start happens.
      const steps = new Map<LaunchStep, StepRecord>(
        LAUNCH_STEPS.filter((step) => (reason === "rebuild" ? step === "image" : step !== "worker")).map(
          (step) => [step, emptyStep()],
        ),
      );
      const record: LaunchRecord = {
        id: randomUUID(),
        box,
        owner,
        for: reason,
        startedAt: now,
        steps,
        waiting: undefined,
        refs: 1,
        ok: true,
        code: undefined,
        ended: false,
        stopped: false,
        watchdog: null,
        lastSent: 0,
        timer: null,
      };
      byBox.set(key, record);
      record.watchdog = clock.setTimeout(() => {
        if (record.ended) return;
        record.ok = false;
        record.code = "timeout";
        failRunning(record, "timeout");
        deps.logger.warn("launch_abandoned", { box: key });
        finish(record);
      }, LAUNCH_MAX_MS);
      emit(record, true);
      return handleOf(record, true);
    },
    activeFor: (box) => {
      const record = byBox.get(boxKey(box));
      return record ? viewOf(record) : null;
    },
    handleFor: (box) => {
      const record = byBox.get(boxKey(box));
      return record ? handleOf(record, false) : null;
    },
    live,
    stop(id) {
      const record = [...byBox.values()].find((candidate) => candidate.id === id);
      if (!record) return null;
      const view = viewOf(record);
      record.stopped = true;
      record.ok = false;
      record.code = "stopped";
      failRunning(record, "stopped");
      finish(record);
      return view;
    },
    close() {
      for (const record of [...byBox.values()]) {
        record.ok = false;
        record.code = "closed";
        failRunning(record, "closed");
        finish(record);
      }
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    subscribedOwners: () =>
      [...seenOwners].filter((owner) => hub?.hasSubscribers("launches", owner) === true),
  };
}
