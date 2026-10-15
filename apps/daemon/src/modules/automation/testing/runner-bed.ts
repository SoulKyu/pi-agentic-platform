import { AutomationSettings, type Caller, type EventFrame, type TriggerInput } from "@pap/contracts";
import { type Mock, vi } from "vitest";
import { testCaller } from "../../../testing/caller.ts";
import { createOutbox, type EffectContext, type Outbox } from "../../../kernel/outbox/index.ts";
import { createStreamHub } from "../../../kernel/ws/stream-hub.ts";
import type { PolicyPort } from "../../policy/index.ts";
import { createRunsModule, type RunEndEvent, type RunStartEvent } from "../../runs/index.ts";
import { assistantEnd as piAssistantEnd } from "../../runs/testing/events.ts";
import type { SessionsAutomationPort } from "../../sessions/index.ts";
import {
  createDryRun,
  createJournal,
  createManual,
  createReleaseTools,
  createTaskEngine,
  createTriggerStore,
  type Engine,
  type FireInput,
  type Operations,
  type PrecheckPort,
} from "../index.ts";
import { requireStepUp } from "../../auth/index.ts";
import { createAutomationBed, manualInput, webhookInput } from "./bed.ts";

const assistantEnd = (cost: number) => piAssistantEnd({ cost });
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Every call of the fakes in the order it happened: tests read the order of `expectOrigin` and `prompt` from it. */
export type Order = string[];

export function fakeSessions(order: Order) {
  let next = 0;
  const attention = new Set<(sessionId: string, needsInput: boolean) => void>();
  const port = {
    createTaskSession: vi.fn<SessionsAutomationPort["createTaskSession"]>(async () => {
      next += 1;
      order.push(`create:s${next}`);
      return { sessionId: `s${next}` };
    }),
    prompt: vi.fn(async (input: { sessionId: string }): Promise<"started" | "queued" | "handled"> => {
      order.push(`prompt:${input.sessionId}`);
      return "started";
    }),
    abort: vi.fn(async (_ownerId: string, sessionId: string) => void order.push(`abort:${sessionId}`)),
    releaseIdle: vi.fn((_ownerId: string, sessionId: string): "released" | "busy" | "cold" => {
      order.push(`release:${sessionId}`);
      return "released";
    }),
    archive: vi.fn((_ownerId: string, sessionId: string) => void order.push(`archive:${sessionId}`)),
    state: vi.fn<SessionsAutomationPort["state"]>(() => ({
      archived: false,
      running: false,
      needsInput: false,
    })),
    answerUnattended: vi.fn((_ownerId: string, sessionId: string): number => {
      order.push(`answer:${sessionId}`);
      return 1;
    }),
    onAttention: (listener: (sessionId: string, needsInput: boolean) => void) => {
      attention.add(listener);
      return () => void attention.delete(listener);
    },
  };
  return {
    ...port,
    /** The shell publisher's flush: a session started or stopped waiting for an answer. */
    attend: (sessionId: string, needsInput: boolean): void => {
      for (const listener of [...attention]) listener(sessionId, needsInput);
    },
  } satisfies Pick<
    SessionsAutomationPort,
    | "createTaskSession"
    | "prompt"
    | "abort"
    | "releaseIdle"
    | "archive"
    | "state"
    | "answerUnattended"
    | "onAttention"
  > & { attend(sessionId: string, needsInput: boolean): void };
}

export interface FakeRuns {
  readonly port: {
    onRunStart(listener: (event: RunStartEvent) => void): () => void;
    onRunEnd(listener: (event: RunEndEvent) => void): () => void;
    expectOrigin: Mock<
      (sessionId: string, expectation: { origin: string; taskId: string | null }) => boolean
    >;
    clearExpected: Mock<(sessionId: string) => void>;
    markEnding: Mock<(sessionId: string, errorClass: "deadline" | "run_budget" | "budget") => void>;
    onLiveCost(listener: (sessionId: string, ownerId: string, runCostUsd: number) => void): () => void;
    onResumeSkipped(listener: (sessionId: string, reason: string) => void): () => void;
    sessionCost(sessionId: string): number | null;
    limitResetAt(sessionId: string): number | null;
    spentToday(): number;
    spentTodayOf(ownerId: string, timeZone: string | null, taskIds: readonly string[]): number;
  };
  readonly costs: Map<string, number>;
  /** What `spentToday` answers (dollars) and what `spentTodayOf` adds up per task. */
  spent: { value: number };
  taskSpend: Map<string, number>;
  /** The assistant message or compaction that brought a run's cost to `runCostUsd`. */
  liveCost(sessionId: string, runCostUsd: number, ownerId?: string): void;
  /** The runs module did not start a resume. */
  skipResume(sessionId: string, reason: string): void;
  listeners(): { starts: number; ends: number };
  startRun(sessionId: string, taskId: string | null, ownerId?: string, origin?: string): void;
  endRun(event: Partial<RunEndEvent> & { sessionId: string; status: RunEndEvent["status"] }): void;
}

export function fakeRuns(order: Order): FakeRuns {
  const starts = new Set<(event: RunStartEvent) => void>();
  const ends = new Set<(event: RunEndEvent) => void>();
  const costs = new Map<string, number>();
  const lives = new Set<(sessionId: string, ownerId: string, runCostUsd: number) => void>();
  const skips = new Set<(sessionId: string, reason: string) => void>();
  const spent = { value: 0 };
  const resets = new Map<string, number>();
  const taskSpend = new Map<string, number>();
  return {
    spent,
    taskSpend,
    liveCost: (sessionId, runCostUsd, ownerId = "u1") => {
      for (const listener of [...lives]) listener(sessionId, ownerId, runCostUsd);
    },
    skipResume: (sessionId, reason) => {
      for (const listener of [...skips]) listener(sessionId, reason);
    },
    port: {
      onLiveCost: (listener: (sessionId: string, ownerId: string, runCostUsd: number) => void) => {
        lives.add(listener);
        return () => void lives.delete(listener);
      },
      onResumeSkipped: (listener: (sessionId: string, reason: string) => void) => {
        skips.add(listener);
        return () => void skips.delete(listener);
      },
      markEnding: vi.fn<(sessionId: string, errorClass: "deadline" | "run_budget" | "budget") => void>(
        (sessionId, errorClass) => void order.push(`ending:${sessionId}:${errorClass}`),
      ),
      onRunStart: (listener: (event: RunStartEvent) => void) => {
        starts.add(listener);
        return () => void starts.delete(listener);
      },
      onRunEnd: (listener: (event: RunEndEvent) => void) => {
        ends.add(listener);
        return () => void ends.delete(listener);
      },
      expectOrigin: vi.fn<
        (sessionId: string, expectation: { origin: string; taskId: string | null }) => boolean
      >((sessionId) => {
        order.push(`expect:${sessionId}`);
        return true;
      }),
      clearExpected: vi.fn<(sessionId: string) => void>(),
      sessionCost: (sessionId: string): number | null => costs.get(sessionId) ?? null,
      limitResetAt: (sessionId: string): number | null => resets.get(sessionId) ?? null,
      spentToday: (): number => spent.value,
      spentTodayOf: (_owner, _zone, ids) => ids.reduce((sum, id) => sum + (taskSpend.get(id) ?? 0), 0),
    },
    costs,
    listeners: () => ({ starts: starts.size, ends: ends.size }),
    startRun(sessionId: string, taskId: string | null, ownerId = "u1", origin = "manual"): void {
      resets.delete(sessionId);
      for (const listener of [...starts])
        listener({ runId: `r-${sessionId}`, sessionId, ownerId, taskId, origin });
    },
    endRun(event: Partial<RunEndEvent> & { sessionId: string; status: RunEndEvent["status"] }): void {
      if (event.status === "limited" && event.limitResetAt != null)
        resets.set(event.sessionId, event.limitResetAt);
      for (const listener of [...ends])
        listener({
          runId: `r-${event.sessionId}`,
          ownerId: "u1",
          taskId: null,
          origin: "manual",
          costUsd: 0,
          errorClass: null,
          limitResetAt: null,
          ...event,
        });
    },
  };
}

export function fakePolicy() {
  const ended: string[] = [];
  const unattended: Array<{ ownerId: string; sessionId: string }> = [];
  const released = new Set<string>();
  return {
    ended,
    unattended,
    released,
    port: {
      endTaskPolicy: vi.fn((_ownerId: string, sessionId: string) => {
        ended.push(sessionId);
        const at = unattended.findIndex((entry) => entry.sessionId === sessionId);
        if (at >= 0) unattended.splice(at, 1);
      }),
      unattendedSessions: () => unattended.map((entry) => ({ ...entry })),
      sessionPolicy: (_ownerId: string, sessionId: string) => ({
        mode: "supervised" as const,
        explicit: true,
        taint: { tainted: false, epoch: 0 },
        toolAllowlist: released.has(sessionId) ? null : ["read"],
        unattended: false,
        recorded: true,
      }),
    } satisfies Pick<PolicyPort, "endTaskPolicy" | "unattendedSessions" | "sessionPolicy">,
  };
}

/** The runner over a real database and a fake clock; the sessions, the runs and the policy are fakes. */
export function createRunnerBed(options: { readOnly?: boolean; startAt?: number; realRuns?: boolean } = {}) {
  const base = createAutomationBed({ startAt: options.startAt });
  const order: Order = [];
  const sessions = fakeSessions(order);
  const runs = fakeRuns(order);
  // `realRuns`: the engine reads the real registry, so the budget sees what the runs module counts.
  const registry = options.realRuns
    ? createRunsModule({ db: base.db, clock: base.clock, logger: base.logger, appendLine: () => {} })
    : null;
  const policy = fakePolicy();
  /** Whether a resume's continuation is on its way into the session: the resume module's `sending`. */
  const resending = { value: false };
  const settings = { value: AutomationSettings.parse({}), owners: new Map<string, AutomationSettings>() };
  const hub = createStreamHub(undefined, base.clock);
  const frames: EventFrame[] = [];
  const triggerStore = createTriggerStore(base.db);
  let ids = 0;
  let spends = 0;
  let current: { engine: Engine; outbox: Outbox } | undefined;
  const make = (readOnly = options.readOnly ?? false) => {
    current?.engine.stop();
    const outbox = createOutbox({ db: base.db, clock: base.clock, logger: base.logger, readOnly });
    const engine = createTaskEngine({
      db: base.db,
      clock: base.clock,
      logger: base.logger,
      triggers: base.triggers,
      triggerMarks: {
        fired: (ownerId, id, at) => void triggerStore.markFired(ownerId, id, at),
        started: (ownerId, id, at) => void triggerStore.markStarted(ownerId, id, at),
      },
      sessions,
      runs: registry?.port ?? runs.port,
      policy: policy.port,
      settings: { automation: (ownerId) => settings.owners.get(ownerId) ?? settings.value },
      outbox,
      hub,
      readOnly,
      newId: () => `task-${++ids}`,
      // The tests name the receipt of a resume by session.
      resumeSending: () => resending.value,
      resumeKeys: (task) => (task.session_id === null ? [] : [`resume:${task.session_id}:r1:5`]),
    });
    current = { engine, outbox };
    return engine;
  };
  make();
  base.onTriggerChange((change) => current?.engine.stream.triggerChanged(change));
  hub.open({
    connectionId: "c1",
    sub: "sub1",
    stream: "tasks",
    key: "u1",
    after: undefined,
    send: (frame) => void frames.push(frame),
  });
  const owner = base.owner();
  return {
    ...base,
    order,
    resending,
    sessions,
    runs,
    policy,
    settings,
    hub,
    /** A run of a task in the real registry (`realRuns`): finished, or still open with `live`. */
    spend: (
      taskId: string | null,
      costUsd: number,
      how: { origin?: string; ownerId?: string; live?: boolean } = {},
    ): void => {
      const service = registry as NonNullable<typeof registry>;
      const { origin = "manual", ownerId = "u1", live = false } = how;
      const session = { id: `spent-${++spends}`, ownerId };
      service.port.expectOrigin(session.id, { origin, taskId });
      service.observer.onRecord(session, "run_start", { origin: "user" }, null);
      service.observer.onEvent(session.id, assistantEnd(costUsd));
      if (!live) service.observer.onRecord(session, "run_end", { aborted: false }, null);
    },
    get outbox(): Outbox {
      return (current as NonNullable<typeof current>).outbox;
    },
    get engine(): Engine {
      return (current as NonNullable<typeof current>).engine;
    },
    frames,
    /** "Use my normal tools" over the bed: `clear` stands for the policy module's `clearTaskPolicy`. */
    releaseTools: (
      clear: (ownerId: string, sessionId: string) => void = (_o, id) => void policy.released.add(id),
    ) =>
      createReleaseTools({
        store: (current as NonNullable<typeof current>).engine.store,
        clock: base.clock,
        audit: base.audit.port,
        policy: { clearTaskPolicy: clear, sessionPolicy: policy.port.sessionPolicy },
        sessions,
        requireStepUp,
        announce: (row) => (current as NonNullable<typeof current>).engine.runner.announce(row.id, row.state),
      }),
    /** Manual fire, dry-run and the journal over the bed's engine; `precheck` stands for the runner of Task 9. */
    operations: (precheck?: PrecheckPort["run"]): Operations => {
      const { engine } = current as NonNullable<typeof current>;
      const port = precheck ? { precheck: { run: precheck } } : {};
      return {
        manual: createManual({
          db: base.db,
          clock: base.clock,
          logger: base.logger,
          fire: engine.fire,
          triggers: base.triggers,
          settings: { automation: (ownerId) => settings.owners.get(ownerId) ?? settings.value },
          gates: engine.gates,
          ...port,
        }),
        dryRun: createDryRun({
          clock: base.clock,
          logger: base.logger,
          triggers: base.triggers,
          store: engine.store,
          gates: engine.gates,
          settings: { automation: (ownerId) => settings.owners.get(ownerId) ?? settings.value },
          ...port,
        }),
        journal: createJournal({
          db: base.db,
          triggers: base.triggers,
          runs: registry?.port ?? runs.port,
        }),
      };
    },
    /** A new engine over the same database, the old one stopped: the daemon after a restart. */
    restart: (opts: { readOnly?: boolean } = {}): Engine => make(opts.readOnly ?? options.readOnly ?? false),
    trigger: (input: TriggerInput = manualInput(base.folder), as: Caller = owner) =>
      base.triggers.create(as, input).trigger,
    webhook: () => base.triggers.create(owner, webhookInput(base.folder)).trigger,
    /** The owner `u2`, who has confirmed the password. */
    other: (): Caller => testCaller({ userId: "u2", stepUpUntil: base.clock.now() + 60_000 }),
    tasks: () =>
      base.db.all<{ id: string; state: string; reason: string | null; session_id: string | null }>(
        "SELECT id, state, reason, session_id FROM tasks ORDER BY created_at, id",
      ),
    effects: () =>
      base.db.all<{ status: string; payload: string }>(
        "SELECT status, payload FROM outbox WHERE kind = 'task.start' ORDER BY id",
      ),
  };
}
export type RunnerBed = ReturnType<typeof createRunnerBed>;

export const fireInput = (overrides: Partial<FireInput> = {}): FireInput => ({
  ownerId: "u1",
  source: "manual",
  payload: null,
  precheck: null,
  dedupKey: null,
  title: "Nightly check",
  detail: null,
  gated: true,
  gates: { exemptDisabled: true },
  retry: null,
  ...overrides,
});

/** What the outbox gives a `task.start` handler. */
export const effectContext = (signal: AbortSignal = new AbortController().signal): EffectContext => ({
  effectId: 1,
  attempts: 0,
  ownerId: "u1",
  signal,
  markSent: () => {},
  cancelRequested: () => false,
});
