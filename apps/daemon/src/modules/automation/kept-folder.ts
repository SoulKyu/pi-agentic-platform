import { readdirSync } from "node:fs";
import { keptKeyOf, type TriggerInput } from "@pap/contracts";
import type { TimerHandle } from "../../kernel/clock.ts";
import { guardTimer } from "../../kernel/timer-guard.ts";
import type { TriggersDeps } from "./triggers.ts";
import { parsePolicy, type TaskPolicySnapshot, type TaskRow } from "./tasks.ts";

/**
 * The key a task's VM keeps its folder under: the task's own snapshot says so (K-R2), and only an agent's isolated task of a
 * trigger has one. Null for every other task.
 */
export const keepKeyOfTask = (row: TaskRow, policy: TaskPolicySnapshot): string | null =>
  policy.keep === true && row.target === "isolated" && row.agent_id !== null && row.trigger_id !== null
    ? keptKeyOf(row.trigger_id)
    : null;

/**
 * The key a running or waiting task's relaunch (a resume after a usage limit, a worker released idle) keeps its folder under:
 * the same rule as the queued start (`currentSnapshot`), read again at every spawn (I2). Null when its trigger stopped keeping.
 */
export function relaunchKeepKey(row: TaskRow, trigger: TriggerInput | null): string | null {
  const fired = parsePolicy(row.policy);
  return fired === null ? null : keepKeyOfTask(row, currentSnapshot(row, fired, trigger));
}

/** The module's `keptKeyOf`: a task session still running or waiting for a quota keeps its folder if its trigger does. */
export function createKeptKeyOf(
  store: { bySession(sessionId: string): TaskRow | undefined },
  triggers: { get(ownerId: string, id: string): { input: TriggerInput | null } | null },
) {
  return (ownerId: string, sessionId: string): string | null => {
    const row = store.bySession(sessionId);
    if (!row || row.owner_id !== ownerId || (row.state !== "running" && row.state !== "limited")) return null;
    return relaunchKeepKey(row, triggers.get(ownerId, row.trigger_id ?? "")?.input ?? null);
  };
}

/** The agent whose kept folder a saved trigger owns; null when it keeps none (not an agent, a thread target, `keep` off). */
const keeperOf = (input: TriggerInput | null): string | null => {
  const agent = input?.execution.agent;
  return agent?.keep === true && agent.target === "isolated" ? agent.agentId : null;
};

const RETRY_MS = 60_000;
const RETRIES_MAX = 30;

/** What the forgetter reads of the triggers' own dependencies. */
export type KeptForgetterDeps = Pick<TriggersDeps, "agents" | "logger" | "clock">;

/**
 * The kept folder goes when its trigger is deleted, stops keeping, or runs as another agent or target (K2), and again at the
 * end of every kept task (`ended`: a run that was in flight at the edit, or a forget that gave up, leaves a disk behind).
 * Best effort: the agent-vm side is asked for the old agent, and a failure is logged, never thrown, never the owner's error.
 * A forget that answers `busy` (a live VM holds the disk) or fails (pap-vmd unreachable) is asked again every 60 s on the
 * clock, at most 30 times, then dropped with one `kept_forget_gave_up`. The retries are in memory: a daemon restart drops them
 * and the disk stays until its agent is deleted (turning keep on again then reuses its old content).
 */
export function createKeptForgetter(
  deps: KeptForgetterDeps,
  /** The trigger as saved now (null: gone): a retry stops when it keeps that agent's folder again. */
  current: (ownerId: string, triggerId: string) => TriggerInput | null,
) {
  /** One forget per trigger and agent: a trigger moved A to B and back keeps both folders in view. */
  const pending = new Map<string, TimerHandle | null>();
  const keyOf = (triggerId: string, agentId: string): string => `${triggerId}:${agentId}`;
  function end(key: string): void {
    pending.delete(key);
  }
  function attempt(ownerId: string, agentId: string, triggerId: string, left: number): void {
    const key = keyOf(triggerId, agentId);
    const forget = deps.agents?.ports()?.forgetKept;
    if (forget === undefined) return end(key);
    const again = (): void => {
      if (left === 0) {
        end(key);
        return deps.logger.warn("kept_forget_gave_up", { triggerId });
      }
      pending.set(
        key,
        deps.clock.setTimeout(
          () =>
            void guardTimer(
              deps.logger,
              "kept_forget",
              () => {
                pending.set(key, null);
                try {
                  if (keeperOf(current(ownerId, triggerId)) === agentId) return end(key);
                } catch (error) {
                  end(key);
                  throw error;
                }
                attempt(ownerId, agentId, triggerId, left - 1);
              },
              deps.clock,
            ),
          RETRY_MS,
        ),
      );
    };
    new Promise<"done" | "busy">((resolve) => resolve(forget(ownerId, agentId, triggerId))).then(
      (answer) => (answer === "done" ? end(key) : again()),
      (error: unknown) => {
        deps.logger.warn("kept_folder_forget_failed", { triggerId, err: error });
        again();
      },
    );
  }
  function start(ownerId: string, triggerId: string, agentId: string): void {
    const key = keyOf(triggerId, agentId);
    if (pending.has(key)) return;
    pending.set(key, null);
    attempt(ownerId, agentId, triggerId, RETRIES_MAX);
  }
  return {
    /** A trigger was saved or deleted: its old agent's folder goes unless the new trigger keeps it. */
    changed(
      ownerId: string,
      triggerId: string,
      before: TriggerInput | null,
      after: TriggerInput | null,
    ): void {
      const agentId = keeperOf(before);
      if (agentId !== null && keeperOf(after) !== agentId) start(ownerId, triggerId, agentId);
    },
    /** A kept task of this trigger and agent ended: its folder goes when the trigger does not keep it any more. */
    ended(ownerId: string, triggerId: string, agentId: string): void {
      if (keeperOf(current(ownerId, triggerId)) !== agentId) start(ownerId, triggerId, agentId);
    },
    /** Shutdown: the pending retries are dropped. */
    stop(): void {
      for (const timer of pending.values()) if (timer !== null) deps.clock.clearTimeout(timer);
      pending.clear();
    },
  };
}
export type KeptForgetter = ReturnType<typeof createKeptForgetter>;

/** Any end of an isolated task that ran on its trigger's kept folder: the folder may be stale by now (I1). */
export function keptTaskEnded(kept: Pick<KeptForgetter, "ended">, row: TaskRow): void {
  const policy = parsePolicy(row.policy);
  const triggerId = policy?.keepTrigger ?? row.trigger_id;
  if (row.target === "isolated" && row.agent_id !== null && policy?.keep === true && triggerId !== null)
    kept.ended(row.owner_id, triggerId, row.agent_id);
}

/**
 * K-R2 amended: a queued task starts with the snapshot it fired with, except that its kept folder is only used while its
 * trigger still keeps it for that agent as an isolated task. Otherwise the task runs on a blank disk (the key is dropped).
 */
export function currentSnapshot(
  row: TaskRow,
  policy: TaskPolicySnapshot,
  trigger: TriggerInput | null,
): TaskPolicySnapshot {
  if (policy.keep !== true || keeperOf(trigger) === row.agent_id) return policy;
  const rest = { ...policy };
  delete rest.keep;
  return rest;
}

/** Whether a folder holds anything: a task that starts again must not read its first attempt's files as its own. */
export function holdsFiles(path: string): boolean {
  try {
    return readdirSync(path).length > 0;
  } catch {
    return true;
  }
}
