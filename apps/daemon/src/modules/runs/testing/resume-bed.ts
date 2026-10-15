import type { ApprovalMode } from "@pap/contracts";
import { createOutbox, type Outbox } from "../../../kernel/outbox/index.ts";
import type { Resume, ResumeDeps, RunsService, RunsStore } from "../index.ts";
import { openRunsBed, type RunsBed } from "./bed.ts";
import { assistantEnd } from "./events.ts";

export const SESSION = { id: "s1", ownerId: "u1" };

/** The session the resume talks to, as the sessions port would answer. Every field is changed by the test. */
export interface FakeSessions {
  exists: boolean;
  archived: boolean;
  running: boolean;
  admits: boolean;
  /** A prompt or reopen of the owner is in flight, its run not started. */
  pending: boolean;
  mode: ApprovalMode | "throw";
  prompts: string[];
  /** What the prompt answers. */
  disposition: "started" | "queued" | "handled";
  /** Runs inside `prompt`, after the call was recorded. */
  onPrompt: () => Promise<void> | void;
}

export interface ResumeBed {
  readonly bed: RunsBed;
  readonly runs: RunsService;
  readonly outbox: Outbox;
  readonly resume: Resume;
  readonly sessions: FakeSessions;
  readonly settings: { autoResume: boolean; dailyBudgetUsd: number | null; paused: boolean };
  readonly skipped: string[];
  /** The task of each session, and the tasks whose trigger is over its own daily budget. */
  readonly sessionTasks: Map<string, string>;
  readonly overTasks: Set<string>;
  readonly expected: Array<{ origin: string; taskId: string | null }>;
  readonly changed: string[];
  /** Ends a run of the session with a provider error; returns its id. */
  limitRun(text: string, session?: { id: string; ownerId: string }): string;
  startRun(origin?: string): void;
  /** The one outbox row's status, sent mark and next time. */
  row(): { status: string; sent_at: number | null; next_at: number; cancel_requested: number } | undefined;
  close(): void;
}

/** The module's own factories, handed in by the test: a `testing/` file may not reach into the module's files (lint). */
export interface ResumeFactories {
  createRunsService(deps: {
    store: RunsStore;
    clock: RunsBed["clock"];
    logger: RunsBed["logger"];
    newId: () => string;
    exportRun: () => void;
  }): RunsService;
  createRunsStore(db: RunsBed["db"]): RunsStore;
  createResume(deps: ResumeDeps): Resume;
}

export function openResumeBed({
  createRunsService,
  createRunsStore,
  createResume,
}: ResumeFactories): ResumeBed {
  const bed = openRunsBed();
  let counter = 0;
  const runs = createRunsService({
    store: createRunsStore(bed.db),
    clock: bed.clock,
    logger: bed.logger,
    newId: () => `run-${++counter}`,
    exportRun: () => {},
  });
  const outbox = createOutbox({ db: bed.db, clock: bed.clock, logger: bed.logger, readOnly: false });
  const sessions: FakeSessions = {
    exists: true,
    archived: false,
    running: false,
    admits: true,
    pending: false,
    mode: "supervised",
    prompts: [],
    disposition: "started",
    onPrompt: () => {},
  };
  const settings = { autoResume: true, dailyBudgetUsd: 5 as number | null, paused: false };
  const skipped: string[] = [];
  const overTasks = new Set<string>();
  const sessionTasks = new Map<string, string>();
  const expected: Array<{ origin: string; taskId: string | null }> = [];
  const changed: string[] = [];
  runs.port.onResumeSkipped((sessionId, reason) => void skipped.push(`${sessionId}:${reason}`));
  const resume = createResume({
    clock: bed.clock,
    logger: bed.logger,
    runs,
    port: {
      spentToday: (ownerId, zone) => runs.port.spentToday(ownerId, zone),
      expectOrigin: (sessionId, expectation) => {
        expected.push(expectation);
        return runs.port.expectOrigin(sessionId, expectation);
      },
      clearExpected: runs.port.clearExpected,
      onRunEnd: runs.port.onRunEnd,
    },
    outbox,
    settings: () => ({ ...settings, timezone: null }),
    taskOf: (_ownerId, sessionId) => {
      const taskId = sessionTasks.get(sessionId);
      return taskId === undefined ? null : { taskId, overBudget: overTasks.has(taskId) };
    },
    modeOf: () => {
      if (sessions.mode === "throw") throw new Error("policy unreadable");
      return sessions.mode;
    },
    limitChanged: (_ownerId, sessionId) => void changed.push(sessionId),
    sessions: {
      state: (ownerId, sessionId) =>
        sessions.exists && ownerId === "u1" && sessionId === "s1"
          ? { archived: sessions.archived, running: sessions.running, needsInput: false }
          : null,
      admits: () => sessions.admits,
      promptPending: () => sessions.pending,
      async prompt({ text }) {
        sessions.prompts.push(text);
        await sessions.onPrompt();
        return sessions.disposition;
      },
    },
  });
  resume.attach();
  const row: ResumeBed["row"] = () =>
    bed.db.get("SELECT status, sent_at, next_at, cancel_requested FROM outbox ORDER BY id DESC LIMIT 1");
  return {
    bed,
    runs,
    outbox,
    resume,
    sessions,
    settings,
    skipped,
    sessionTasks,
    overTasks,
    expected,
    changed,
    startRun: (origin = "user") => runs.observer.onRecord(SESSION, "run_start", { origin }, null),
    limitRun(text, session = SESSION) {
      runs.observer.onRecord(session, "run_start", { origin: "user" }, null);
      runs.observer.onEvent(
        session.id,
        assistantEnd({ input: 1, cost: 0.1 }, { stopReason: "error", errorMessage: text }),
      );
      runs.observer.onRecord(session, "run_end", {}, null);
      return `run-${counter}`;
    },
    row,
    close: () => bed.close(),
  };
}
