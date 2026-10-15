import { PapError, type SessionStreamEvent } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { LiveSession } from "./live-session.ts";
import type { SessionRow } from "./store.ts";

/** The longest a prompt waits for the lanes side before it goes (M9-RT-08). A restore in progress is not capped. */
export const BEFORE_PROMPT_CAP_MS = 15_000;

export interface LaneRunInfo {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly leafId: string | null;
}

/** What the lanes module asks to see of a session's runs. Task 7 fills `closed` and `holdsFiles`; Task 15 the captures. */
export interface LaneRunHooks {
  /** The lane holding `cwd` is being removed (`archiving`) or is gone (`archived`): no prompt starts in it. */
  closed(cwd: string): "archiving" | "archived" | null;
  /** A restore is running in the lane: the prompt waits for it, with no cap of its own. */
  holdsFiles(cwd: string): Promise<void> | null;
  /** Throws `forbidden` when `cwd` is inside ANOTHER owner's lane: a worker starts there for no one else (Task 8's carry). */
  assertOwn?(ownerId: string, cwd: string): void;
  /**
   * Before an idle session's prompt. Answers `undefined`, synchronously, when there is nothing to do: the prompt then
   * does not yield (the busy rule of M2R88). After the cap, `released.value` is true and the hook must write nothing.
   */
  beforePrompt(info: LaneRunInfo, released: { readonly value: boolean }): Promise<void> | undefined;
  /** A run ended: the session went from `running` to `idle`. */
  afterRun(info: LaneRunInfo): void;
}

const NO_HOOKS: LaneRunHooks = {
  closed: () => null,
  holdsFiles: () => null,
  beforePrompt: () => undefined,
  afterRun: () => {},
};

export interface LaneHooksSlot {
  /** The lanes module fills the slot once; a later call replaces it. */
  set(hooks: LaneRunHooks): void;
  /** Called before a worker starts, for a new session or a reopened one. */
  assertOwn(ownerId: string, cwd: string): void;
  /**
   * Called by `sessions.prompt` right before the prompt reaches the worker. Throws only for a closed lane. Answers
   * `undefined` when there is nothing to wait for: the caller then does not yield, so `session.prompt` marks the
   * session busy in the same tick as before (the busy rule of M2R88).
   */
  beforePrompt(
    row: SessionRow,
    session: LiveSession,
    /** The caller's preference; ignored: the browser always sends one (M2R58), and only the session's state decides. */
    streamingBehavior: "steer" | "followUp" | undefined,
  ): Promise<void> | undefined;
  /** A prompt of this session is waiting in the hooks (a restore, or the capture): the session is not idle for anyone else. */
  waiting(sessionId: string): boolean;
  /** Called for every event a session publishes. */
  published(sessionId: string, event: SessionStreamEvent): void;
  /** Sessions whose last status is remembered: at most one per live session. */
  tracked(): number;
}

export function createLaneHooks(deps: {
  readonly clock: Clock;
  readonly logger: Logger;
  /** The run info of a session, or null when it is unknown (gone). */
  infoOf(sessionId: string): LaneRunInfo | null;
}): LaneHooksSlot {
  let hooks = NO_HOOKS;
  const lastStatus = new Map<string, string>();

  const waiting = new Map<string, Promise<void>>();

  function assertOpen(cwd: string): void {
    const closed = hooks.closed(cwd);
    if (closed === "archiving") throw new PapError("session_busy");
    if (closed === "archived") throw new PapError("not_found");
  }

  /** The hook, raced against the cap; `undefined` when the hook has nothing to do. */
  function capture(info: LaneRunInfo): Promise<void> | undefined {
    const released = { value: false };
    let started: Promise<void> | undefined;
    try {
      started = hooks.beforePrompt(info, released);
    } catch (error) {
      deps.logger.warn("lane_before_prompt_failed", { err: error });
      return undefined;
    }
    if (!started) return undefined;
    // The hook may settle after the cap; a late rejection is still logged, never unhandled.
    const hook = started.catch((error: unknown) =>
      deps.logger.warn("lane_before_prompt_failed", { err: error }),
    );
    let timer: ReturnType<Clock["setTimeout"]> | undefined;
    const late = new Promise<void>((resolve) => {
      timer = deps.clock.setTimeout(() => {
        released.value = true;
        deps.logger.warn("checkpoint_before_late", { sessionId: info.sessionId });
        resolve();
      }, BEFORE_PROMPT_CAP_MS);
    });
    return Promise.race([hook, late]).finally(() => {
      if (timer) deps.clock.clearTimeout(timer);
    });
  }

  return {
    set: (next) => {
      hooks = next;
    },
    assertOwn: (ownerId, cwd) => hooks.assertOwn?.(ownerId, cwd),
    beforePrompt(row, session) {
      assertOpen(row.cwd);
      if (session.status() !== "idle" || session.busy()) return undefined;
      // A second prompt waits for the capture already running: one capture per wait.
      const running = waiting.get(row.id);
      if (running) return running;
      const held = hooks.holdsFiles(row.cwd);
      const info = { ownerId: row.ownerId, sessionId: row.id, cwd: row.cwd, leafId: session.leafId() };
      const work = held
        ? held
            .catch((error: unknown) => deps.logger.warn("lane_restore_wait_failed", { err: error }))
            .then(() => {
              assertOpen(row.cwd);
              return capture(info);
            })
        : capture(info);
      if (!work) return undefined;
      // The lane may have started closing during the waits: no prompt starts in a folder being removed (M9-RT-07).
      const tracked = work.then(() => assertOpen(row.cwd)).finally(() => waiting.delete(row.id));
      waiting.set(row.id, tracked);
      return tracked;
    },
    waiting: (sessionId) => waiting.has(sessionId),
    published(sessionId, event) {
      if (event.kind !== "status") return;
      const before = lastStatus.get(sessionId);
      if (event.status === "cold") lastStatus.delete(sessionId);
      else lastStatus.set(sessionId, event.status);
      if (before !== "running" || event.status !== "idle") return;
      const info = deps.infoOf(sessionId);
      if (!info) return;
      try {
        const result: unknown = hooks.afterRun(info);
        if (result instanceof Promise)
          result.catch((error: unknown) => deps.logger.warn("lane_after_run_failed", { err: error }));
      } catch (error) {
        deps.logger.warn("lane_after_run_failed", { err: error });
      }
    },
    tracked: () => lastStatus.size,
  };
}
