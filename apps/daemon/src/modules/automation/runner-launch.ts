import { PapError, type TaskState } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { Settlement } from "../../kernel/outbox/index.ts";
import type { RunsPort } from "../runs/index.ts";
import type { SessionsAutomationPort } from "../sessions/index.ts";
import type { RunLimits } from "./limits.ts";
import type { Move, TaskRow, TaskStore } from "./tasks.ts";

type Settle = (row: TaskRow, from: readonly TaskState[], to: TaskState, change?: Move) => boolean;

export interface LaunchDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly store: Pick<TaskStore, "move" | "get">;
  readonly marks: { started(ownerId: string, triggerId: string, at: number): void };
  /** The tasks being started and the ones put off: a task that is running now is neither. */
  readonly starting: Map<string, string>;
  readonly putOff: Map<string, number>;
  readonly announce: (id: string, previous: TaskState) => void;
  readonly limits: Pick<RunLimits, "started">;
  readonly runs: Pick<RunsPort, "expectOrigin" | "clearExpected">;
  readonly sessions: Pick<SessionsAutomationPort, "prompt">;
  readonly settle: Settle;
}

export interface LaunchOptions {
  /** What the session is prompted with. */
  readonly text: string;
  /** The task was cancelled between its admission and its mark: whatever the start made for it goes. */
  readonly cancelled?: () => void;
  /** Runs right before the run's origin is armed and the prompt goes (a thread task's card, M11R71). */
  readonly beforePrompt?: () => void;
}

/** A code of ours, never text from outside. */
const reasonOf = (error: unknown): string => (error instanceof PapError ? error.code : "start_failed");
const done: Settlement = { outcome: "done" };

/**
 * The commit of a start, shared by project, isolated and thread tasks: the `running` mark, the run's origin and the prompt
 * follow without an await between them, so a Cancel cannot slip in (M10R37).
 */
export function createLaunch(deps: LaunchDeps) {
  return async function launch(row: TaskRow, sessionId: string, options: LaunchOptions): Promise<Settlement> {
    const { db, clock } = deps;
    const committed = db.transaction(() => {
      const moved = deps.store.move(row.id, ["queued"], "running", { sessionId, startedAt: clock.now() });
      if (moved && row.trigger_id !== null) deps.marks.started(row.owner_id, row.trigger_id, clock.now());
      return moved;
    });
    deps.starting.delete(row.id);
    deps.putOff.delete(row.id);
    if (!committed) {
      options.cancelled?.();
      return done;
    }
    deps.announce(row.id, "queued");
    const started: TaskRow = { ...row, state: "running", session_id: sessionId };
    deps.limits.started(started);
    options.beforePrompt?.();
    if (!deps.runs.expectOrigin(sessionId, { origin: row.origin, taskId: row.id })) {
      deps.settle(started, ["running"], "failed", { reason: "capacity" });
      return done;
    }
    let disposition: "started" | "queued" | "handled";
    try {
      disposition = await deps.sessions.prompt({
        ownerId: row.owner_id,
        sessionId,
        text: options.text,
        // A cancel or a stop during a cold session's reopen drops the prompt at the last moment (N1).
        stillWanted: () => deps.store.get(row.id)?.state === "running",
      });
    } catch (error) {
      deps.runs.clearExpected(sessionId);
      deps.settle(started, ["running"], "failed", { reason: reasonOf(error) });
      return done;
    }
    if (disposition !== "started") {
      deps.runs.clearExpected(sessionId);
      deps.settle(started, ["running"], "failed", { reason: "prompt_rejected" });
    }
    return done;
  };
}
export type Launch = ReturnType<typeof createLaunch>;
