import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import { enqueueEffect, type Outbox } from "../../kernel/outbox/index.ts";
import type { HealthEvents } from "../health/index.ts";
import type { PolicyPort } from "../policy/index.ts";
import type { SessionsAutomationPort } from "../sessions/index.ts";
import type { Runner } from "./runner.ts";
import { isTerminal, type TaskStore } from "./tasks.ts";

export interface BootReport {
  readonly interrupted: number;
  readonly orphans: number;
  readonly retried: number;
  readonly requeued: number;
}

export interface BootDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly store: TaskStore;
  readonly runner: Pick<Runner, "settle" | "retry" | "endHook">;
  readonly policy: Pick<PolicyPort, "unattendedSessions" | "endTaskPolicy">;
  readonly sessions: Pick<SessionsAutomationPort, "archive">;
  readonly outbox: Pick<Outbox, "db">;
  readonly readOnly: boolean;
  /** The health events (Task 3): an orphan session the owner may page on. */
  readonly health?: Pick<HealthEvents, "emit">;
}

const NOTHING: BootReport = { interrupted: 0, orphans: 0, retried: 0, requeued: 0 };

/**
 * The tasks' part of the boot (M10R42), after the outbox and the runs recovered and before the server listens. Not in
 * read-only mode. Every terminal move goes through the runner's `settle`, so Task 5b's end hook hears it.
 */
export function recoverTasks(deps: BootDeps): BootReport {
  if (deps.readOnly) return NOTHING;
  const { store, logger } = deps;

  // 1. No worker survived the restart: what was running is interrupted. The end hook ends its policy (m11).
  const interrupted = store.running();
  for (const row of interrupted) deps.runner.settle(row, ["running"], "interrupted", { reason: "crash" });

  // 2. A session still unattended with no live task: the crash fell between a task's end and its end hook (the task is
  // over: the hook runs now), or between the session and its commit (no task owns it: its policy ends, it is archived).
  let orphans = 0;
  for (const { ownerId, sessionId } of deps.policy.unattendedSessions()) {
    const task = store.bySession(sessionId);
    if (task) {
      if (isTerminal(task.state)) deps.runner.endHook(task, sessionId, task.state);
      continue;
    }
    orphans += 1;
    try {
      deps.policy.endTaskPolicy(ownerId, sessionId);
      deps.sessions.archive(ownerId, sessionId);
    } catch (error) {
      logger.warn("task_orphan_session_failed", { sessionId, err: error });
      deps.health?.emit({ ownerId, kind: "task", code: "task_orphan_session", sourceRef: null });
    }
  }

  // 3. One gated retry for a task the trigger wants repeated after a crash; a retry is never retried.
  let retried = 0;
  for (const row of interrupted) {
    if (row.retry_on_interrupt !== 1 || row.retry_of !== null) continue;
    try {
      deps.runner.retry(row.owner_id, row.id, { gated: true, exemptDisabled: false });
      retried += 1;
    } catch (error) {
      logger.warn("task_boot_retry_skipped", { err: error });
    }
  }

  // 4. A queued task needs a `task.start` to be started: the crash retired the leased ones.
  let requeued = 0;
  for (const ownerId of store.queuedOwners()) {
    const live =
      deps.outbox.db.get<{ n: number }>(
        `SELECT count(*) AS n FROM outbox WHERE kind = 'task.start' AND owner_id = $ownerId AND status IN ('pending', 'leased')`,
        { ownerId },
      )?.n ?? 0;
    const missing = store.counts(ownerId).queued - live;
    if (missing <= 0) continue;
    // The effect only says "start the next task": it is named after one of the queued tasks, the newest first.
    deps.db.transaction(() => {
      for (const taskId of store.queuedIds(ownerId, missing))
        enqueueEffect(deps.outbox.db, { kind: "task.start", ownerId, payload: { taskId } }, deps.clock.now());
    });
    requeued += missing;
  }

  const report = { interrupted: interrupted.length, orphans, retried, requeued };
  if (Object.values(report).some((count) => count > 0)) logger.warn("automation_boot_recovered", report);
  return report;
}
