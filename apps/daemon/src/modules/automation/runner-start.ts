import { PapError, type TaskState } from "@pap/contracts";
import type { Settlement } from "../../kernel/outbox/index.ts";
import { IMAGE_BUILD_MS } from "./image-wait.ts";
import { currentSnapshot } from "./kept-folder.ts";
import { capacityWait } from "./put-off.ts";
import type { RunnerDeps } from "./runner.ts";
import { type Move, parsePolicy, type TaskRow } from "./tasks.ts";

export const CAPACITY_MS = 30_000;

export const done: Settlement = { outcome: "done" };

/** The reason stored for a failure: a code of ours, never text from outside. */
export const reasonOf = (error: unknown): string => (error instanceof PapError ? error.code : "start_failed");

type Settle = (
  row: TaskRow,
  from: readonly TaskState[],
  to: TaskState,
  change?: Move,
  options?: { hold?: boolean },
) => boolean;

export interface RunnerStartContext {
  readonly deps: RunnerDeps;
  readonly settle: Settle;
  readonly discard: (row: TaskRow, sessionId: string) => void;
}

/** The start path of a queued task: its checks, its session, then the launch commit. */
export function createRunnerStart(context: RunnerStartContext) {
  const { deps, settle, discard } = context;
  const { clock } = deps;

  async function start(row: TaskRow, signal: AbortSignal): Promise<Settlement> {
    const fired = parsePolicy(row.policy);
    const policy =
      fired === null
        ? null
        : currentSnapshot(row, fired, deps.triggers.get(row.owner_id, row.trigger_id ?? "")?.input ?? null);
    if (policy === null) {
      settle(row, ["queued"], "failed", { reason: "bad_policy" });
      return done;
    }
    try {
      // An agent's home is inside pap's own folder, which a project task may never use: the agent gate opens it instead.
      if (row.agent_id === null) deps.triggers.resolveFolder(row.cwd, row.owner_id);
    } catch (error) {
      settle(row, ["queued"], "failed", { reason: reasonOf(error) });
      return done;
    }
    // A task admitted before the budget was spent starts after: it fails here, with no session (M10R66).
    if (row.gated === 1 && deps.gates.over(row.owner_id, row.trigger_id, row.agent_id)) {
      settle(row, ["queued"], "failed", { reason: "budget" });
      return done;
    }
    // The task of an agent's thread prompts the thread it has: its own gate, card and prompt (M11R71).
    if (row.target === "thread") return deps.thread.start(row, signal);
    if (signal.aborted) return { outcome: "retry", code: "deadline" };

    // The box builds its image: no session is made, the task waits and no attempt is spent.
    const building = deps.imageBuild?.(row);
    if (building) {
      const until = clock.now() + IMAGE_BUILD_MS;
      deps.putOff.set(row.id, { until, reason: "image_build", ...building });
      return { outcome: "defer", until };
    }

    let sessionId: string;
    try {
      ({ sessionId } =
        row.agent_id !== null
          ? await deps.agents.begin(row, policy)
          : await deps.sessions.createTaskSession({
              ownerId: row.owner_id,
              cwd: row.cwd,
              policy: {
                mode: policy.mode,
                tools: policy.tools,
                preset: policy.preset,
                tainted: row.tainted === 1,
              },
            }));
    } catch (error) {
      if (error instanceof PapError && error.code === "agent_paused")
        return deps.agents.holdBack(row, settle);
      // The previous run's VM still holds the kept disk: not a failure, not an attempt (K2).
      if (error instanceof PapError && error.code === "conflict" && policy.keep === true)
        return deps.agents.keptBusy(row);
      if (error instanceof PapError && error.code === "capacity") {
        deps.putOff.set(row.id, { until: clock.now() + CAPACITY_MS, ...capacityWait(error) });
        return { outcome: "defer", until: clock.now() + CAPACITY_MS };
      }
      // A launch the person stopped is no failure and is not tried again (spec 3.4): the task ends cancelled.
      const reason = reasonOf(error);
      settle(row, ["queued"], reason === "stopped" ? "cancelled" : "failed", { reason });
      return done;
    }
    if (signal.aborted) {
      discard(row, sessionId);
      return { outcome: "retry", code: "deadline" };
    }
    // A pause that landed while the session was being made is seen here: the session goes, the task waits (M11R75).
    if (row.agent_id !== null && deps.agents.pausedNow(row)) {
      discard(row, sessionId);
      return deps.agents.holdBack(row, settle);
    }

    // Cancelled between the admission and the mark: the session nobody wants goes, and the effect is spent.
    return deps.launch(row, sessionId, { text: row.prompt, cancelled: () => discard(row, sessionId) });
  }

  return start;
}
