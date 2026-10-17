import { type Caller, PapError, type QuarantineResult } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import { withDeadline } from "./deadline.ts";
import type { AgentLinks } from "./links.ts";
import type { AgentStore } from "./store.ts";
import type { AgentGuard } from "./threads.ts";
import { actorOf } from "./view.ts";

export interface QuarantineDeps {
  readonly store: Pick<AgentStore, "get" | "quarantine" | "clearThread">;
  /** Read at each call: the links are bound after the module is built. */
  readonly links: () => AgentLinks;
  /** The agent's thread lock (`threads.locked`): no open or reset of its thread runs inside the sequence. */
  lock<T>(agentId: string, work: () => Promise<T>): Promise<T>;
  /** Shared with the registry: a resume of the agent waits for the sequence to end. */
  readonly guard: Pick<AgentGuard, "quarantining">;
  readonly clock: Pick<Clock, "now" | "setTimeout" | "clearTimeout">;
  readonly logger: Pick<Logger, "warn" | "error">;
  readonly audit: Pick<AuditPort, "append">;
  /** The auth module's password step-up: throws `step_up_required`. */
  requireStepUp(caller: Caller, now: number): void;
  /** The agent's rail entry changed. */
  changed(ownerId: string, agentId: string): void;
}

type Step = QuarantineResult["errors"][number]["step"];

/** A step that waits on a worker or a task gets this long; a slower one is reported as `timeout` and the playbook goes on. */
export const QUARANTINE_STEP_MS = 10_000;

/** What a failing step is called in the answer: a typed refusal keeps its code, anything else is `failed` (never its text). */
function codeOf(error: unknown): string {
  if (error instanceof PapError) return error.code;
  return error instanceof Error && error.message === "deadline" ? "timeout" : "failed";
}

/**
 * The incident playbook (M11R115), a forced and ordered sequence under the agent's thread lock. The first step (pause and
 * `quarantined_at`) is the only one whose failure aborts. Every later step is wrapped: a failure goes to `errors` and the
 * rest still run, so a half-run playbook is never silent. The webhook secrets it rotates are in the answer once.
 */
export function createQuarantine(deps: QuarantineDeps) {
  async function sequence(caller: Caller, agentId: string): Promise<QuarantineResult> {
    const ownerId = caller.userId;
    if (!deps.store.get(ownerId, agentId)) throw new PapError("not_found");
    // Step 1: the agent stops taking work. Its failure aborts the command: nothing else is done.
    try {
      if (!deps.store.quarantine(ownerId, agentId, deps.clock.now())) throw new PapError("not_found");
    } catch (error) {
      if (error instanceof PapError && error.code === "not_found") throw error;
      deps.logger.error("agent_quarantine_failed", { err: error });
      throw new PapError("command_failed");
    }
    const result = { secrets: [], vaultNames: [], tasksCancelled: 0, errors: [] } as {
      secrets: QuarantineResult["secrets"][number][];
      vaultNames: string[];
      tasksCancelled: number;
      errors: QuarantineResult["errors"][number][];
    };
    const links = deps.links();
    const fail = (step: Step, error: unknown): void => {
      deps.logger.warn("agent_quarantine_step_failed", { step, err: error });
      result.errors.push({ step, code: codeOf(error) });
    };
    const bounded = (work: () => Promise<void> | void): Promise<void> =>
      withDeadline(Promise.resolve().then(work), deps.clock, QUARANTINE_STEP_MS);
    const run = async (step: Step, work: () => Promise<void> | void): Promise<void> => {
      try {
        await work();
      } catch (error) {
        fail(step, error);
      }
    };

    // Step 2: its running and queued tasks (and, from Task 30, its children) are cancelled.
    await run("tasks", async () => {
      let cancelled = 0;
      await bounded(async () => {
        cancelled = (await links.automation?.cancelAllOf?.(ownerId, agentId)) ?? 0;
      });
      result.tasksCancelled = cancelled;
    });

    // Step 3: the thread. Every part runs; the first failure is reported. The archive drops the thread's host grants (W5-R52).
    await run("thread", async () => {
      const sessionId = deps.store.get(ownerId, agentId)?.threadSessionId ?? null;
      let first: unknown = null;
      const part = async (work: () => Promise<void> | void): Promise<void> => {
        try {
          await bounded(work);
        } catch (error) {
          first ??= error;
        }
      };
      if (sessionId !== null) {
        await part(() => links.threads?.abort?.(ownerId, sessionId));
        await part(() => links.threads?.releaseIdle(ownerId, sessionId));
        await part(() => links.threads?.archive(ownerId, sessionId));
      }
      // No new thread is made: the next open (after a resume) starts a fresh one.
      await part(() => void deps.store.clearThread(ownerId, agentId, deps.clock.now()));
      await part(() => links.inbox?.clearReply(ownerId, agentId));
      if (first !== null) throw first;
    });

    // Step 4: what the agent waits for from the owner is closed, and its one-use values go. Its scratch folders stay as evidence.
    await run("requests", () => void links.requests?.cancelAllOf(ownerId, agentId));
    await run("once_values", () => links.onceValues?.drop(ownerId, agentId));

    // Step 5: the webhook secrets of its triggers are rotated and returned once. The triggers stay enabled; the pause blocks them.
    await run("triggers", () => {
      const rotated = links.automation?.rotateSecretsOf?.(caller, agentId);
      if (!rotated) return;
      result.secrets.push(...rotated.secrets);
      if (rotated.failed.length > 0) throw new Error("trigger secrets not rotated");
    });

    // Step 6: the names in its vault (never values), for the owner to rotate upstream.
    await run("vault", () => {
      const listed = links.vault?.list?.(caller, agentId);
      if (!listed) return;
      result.vaultNames.push(...listed.entries.map((entry) => entry.name));
      if (listed.state === "unreadable") throw new Error("vault unreadable");
    });

    // Step 7 (M11b, Task 32): the staged memory facts are moved aside; that task registers its step here.

    deps.audit.append({
      ownerId,
      ...actorOf(caller),
      kind: "policy",
      reason: "agent quarantined",
      detail: { agentId, tasksCancelled: result.tasksCancelled, errors: result.errors.length },
    });
    deps.changed(ownerId, agentId);
    return result;
  }

  return {
    /** `agents.quarantine`: the password first, then the sequence. */
    run(caller: Caller, agentId: string): Promise<QuarantineResult> {
      deps.requireStepUp(caller, deps.clock.now());
      deps.guard.quarantining.set(agentId, (deps.guard.quarantining.get(agentId) ?? 0) + 1);
      return deps
        .lock(agentId, () => sequence(caller, agentId))
        .finally(() => {
          const left = (deps.guard.quarantining.get(agentId) ?? 1) - 1;
          if (left > 0) deps.guard.quarantining.set(agentId, left);
          else deps.guard.quarantining.delete(agentId);
        });
    },
  };
}
export type Quarantine = ReturnType<typeof createQuarantine>;
