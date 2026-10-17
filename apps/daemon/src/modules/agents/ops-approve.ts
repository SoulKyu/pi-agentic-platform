import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { guardTimer } from "../../kernel/timer-guard.ts";
import { type PlatformHandler, PlatformRefusal } from "../platform/index.ts";
import { cleanText, type Requests } from "./requests.ts";

/**
 * How long the agent waits: 25 minutes, less the 2 seconds the platform deadline (`PLATFORM_OPS`, 25 minutes) would
 * otherwise win by. The op then answers `{approved: false}` and marks the request `expired` instead of the dispatcher
 * answering `timeout` and leaving the card open.
 */
export const APPROVE_WAIT_MS = 25 * 60_000 - 2_000;

export interface ApproveDeps {
  readonly requests: Pick<Requests, "open" | "wait" | "expire" | "cancel">;
  readonly clock: Pick<Clock, "now" | "setTimeout" | "clearTimeout">;
  readonly logger: Logger;
}

/**
 * `agent.approve` (M11R102): opens a request (title 120, summary 1 000, stripped), then waits for the owner's answer, the
 * op's signal (Stop, a cancel, a dead worker, the daemon's stop) or 25 minutes. `{approved: false}` on a timeout or a
 * cancel. Approving runs nothing: the agent decides what to do with `approved: true`. Every wait goes through the
 * kernel Clock.
 */
export function createApprove(deps: ApproveDeps): PlatformHandler<"agent.approve"> {
  return async (args, ctx) => {
    if (ctx.agentId === null) throw new PlatformRefusal("not_found");
    if (ctx.signal.aborted) return { approved: false };
    const title = cleanText(args.title, 120);
    if (title === null) throw new PlatformRefusal("bad_request");
    const id = deps.requests.open({
      kind: "approve",
      ownerId: ctx.ownerId,
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      title,
      detail: args.summary ?? null,
      expiresAt: deps.clock.now() + APPROVE_WAIT_MS,
    });
    const timer = deps.clock.setTimeout(
      () =>
        void guardTimer(deps.logger, "agent_approve_expiry", () => void deps.requests.expire(id), deps.clock),
      APPROVE_WAIT_MS,
    );
    const stop = () => void deps.requests.cancel(id);
    ctx.signal.addEventListener("abort", stop, { once: true });
    try {
      // An abort between the check above and the listener is caught here.
      if (ctx.signal.aborted) stop();
      return { approved: (await deps.requests.wait(id)) === "approved" };
    } finally {
      deps.clock.clearTimeout(timer);
      ctx.signal.removeEventListener("abort", stop);
    }
  };
}
