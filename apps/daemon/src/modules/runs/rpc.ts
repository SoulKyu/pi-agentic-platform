import type { HandlerTable } from "@pap/contracts";
import type { Resume } from "./resume.ts";
import type { RunsPort } from "./service.ts";

export type RunsRpc = Pick<HandlerTable, "usage.summary">;

export function runsRpc(
  runs: Pick<RunsPort, "summary">,
  /** The owner's automation time zone (null: the server's own). */
  timeZoneOf: (ownerId: string) => string | null,
): RunsRpc {
  return {
    "usage.summary": async ({ range }, ctx) =>
      runs.summary(ctx.caller.userId, range, timeZoneOf(ctx.caller.userId)),
  };
}

export type UsageRpc = Pick<HandlerTable, "subscribe.usage" | "usage.resumeNow" | "usage.cancelResume">;

export function usageRpc(resume: Pick<Resume, "resumeNow" | "cancelResume">): UsageRpc {
  return {
    // The stream is the caller's own: its key is the owner, like `shell`.
    "subscribe.usage": async ({ after }, ctx) => ({
      sub: ctx.openSubscription("usage", ctx.caller.userId, after),
    }),
    "usage.resumeNow": async ({ sessionId }, ctx) => {
      await resume.resumeNow(ctx.caller, sessionId);
      return { ok: true as const };
    },
    "usage.cancelResume": async ({ sessionId }, ctx) => {
      await resume.cancelResume(ctx.caller.userId, sessionId);
      return { ok: true as const };
    },
  };
}
