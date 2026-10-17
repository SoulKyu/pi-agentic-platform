import { type AutomationSettings, inQuietHours } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { type PlatformContext, type PlatformHandler, PlatformRefusal } from "../platform/index.ts";
import type { AgentsPort } from "./service.ts";
import { type AgentTasksPort, type ReminderRequest, refusalOf } from "./task-port.ts";
import { parseWhen } from "./when.ts";

/** What one agent may have waiting, and may make in a rolling day (M11R80). */
export const REMINDERS_PENDING = 5;
export const REMINDERS_PER_DAY = 24;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export interface RemindDeps {
  readonly clock: Pick<Clock, "now">;
  readonly agents: Pick<AgentsPort, "get">;
  readonly tasks: Pick<AgentTasksPort, "reminders" | "overBudget" | "runningRequester" | "remind">;
  readonly settings: { automation(ownerId: string): Pick<AutomationSettings, "quietHours" | "timezone"> };
}

/**
 * The first instant at or after `at` that is outside the owner's quiet hours (M11R80). A window shorter than a day always
 * ends within a day; the walk is by the minute, the unit the window is written in.
 */
export function afterQuietHours(
  at: number,
  quiet: AutomationSettings["quietHours"],
  timeZone: string | null,
): number {
  if (!inQuietHours(quiet, timeZone, at)) return at;
  const start = at - (at % MINUTE_MS);
  for (let minutes = 1; minutes <= DAY_MS / MINUTE_MS; minutes += 1) {
    const candidate = start + minutes * MINUTE_MS;
    if (!inQuietHours(quiet, timeZone, candidate)) return candidate;
  }
  return at;
}

/**
 * The taint branch of `agent.remind` (M11R82), in one place: a reminder set by a tainted caller is a tainted task, and
 * Task 11's thread guard then refuses to put its prompt into the trusted thread. Autonomy (X2a) composes here.
 */
function reminderByTaint(
  ctx: PlatformContext,
  agentId: string,
  note: string,
  notBefore: number,
  requestedBy: string | null,
): ReminderRequest {
  return {
    ownerId: ctx.ownerId,
    agentId,
    note,
    notBefore,
    requestedBy,
    tainted: ctx.tainted,
    sessionId: ctx.sessionId,
  };
}

/**
 * `agent.remind` (M11R80): a one-shot task for the agent itself. Everything is checked and the task made in one step with no
 * await, so the counts that were read are the ones the task is added to.
 */
export function createRemind(deps: RemindDeps): PlatformHandler<"agent.remind"> {
  return (args, ctx) => {
    try {
      const now = deps.clock.now();
      const at = parseWhen(args.when, now);
      if (at === null) throw new PlatformRefusal("bad_request");
      const agentId = ctx.agentId;
      if (agentId === null || deps.agents.get(ctx.ownerId, agentId) === null)
        throw new PlatformRefusal("not_found");
      const counts = deps.tasks.reminders(ctx.ownerId, agentId, now - DAY_MS);
      if (counts.pending >= REMINDERS_PENDING) throw new PlatformRefusal("limit_reached");
      if (counts.created >= REMINDERS_PER_DAY) throw new PlatformRefusal("rate_limited");
      if (deps.tasks.overBudget(ctx.ownerId, agentId)) throw new PlatformRefusal("budget");
      const { quietHours, timezone } = deps.settings.automation(ctx.ownerId);
      const notBefore = afterQuietHours(at, quietHours, timezone);
      // RT-16: a reminder set inside a delegated run stays delegated, so the run it fires cannot delegate again.
      const requestedBy = deps.tasks.runningRequester(ctx.ownerId, agentId);
      const made = deps.tasks.remind(reminderByTaint(ctx, agentId, args.note, notBefore, requestedBy));
      return Promise.resolve({ taskId: made.taskId, at: notBefore });
    } catch (error) {
      return Promise.reject(refusalOf(error));
    }
  };
}
