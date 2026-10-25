import {
  type ErrorCode,
  HELPER_OPS,
  LoginEvent,
  type LoginMethod,
  LoginPrompt,
  PapError,
} from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { HelperHandle, HelperPool } from "../../kernel/helper/pool.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { LoginPublisher } from "./login-publisher.ts";

export const LOGIN_LIMITS = {
  /** Live flows one owner may have (M7R59): a further one is refused, never an older one evicted. */
  perOwner: 2,
  /** A flow ends at this age whatever it is waiting for. */
  deadlineMs: 10 * 60_000,
  /** A flow nobody subscribed to within this long is cancelled. */
  idleMs: 60_000,
  /** A flow whose helper sends this many events or prompts the contract refuses is ended. */
  maxDropped: 8,
  /** Ended flows kept so that a late subscriber still sees how it ended. */
  retained: 16,
} as const;

export interface SignedIn {
  readonly ownerId: string;
  readonly provider: string;
  readonly method: LoginMethod;
}

export interface LoginFlowsDeps {
  readonly helpers: Pick<HelperPool, "run">;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly publisher: Pick<LoginPublisher, "publish" | "forget">;
  readonly newId: () => string;
  /** A flow ended with the credential stored; called once, never after a cancel. */
  readonly onSignedIn: (line: SignedIn) => void;
}

interface Flow {
  readonly id: string;
  readonly ownerId: string;
  readonly provider: string;
  readonly method: LoginMethod;
  handle: HelperHandle | null;
  ended: boolean;
  cancelled: boolean;
  attached: boolean;
  dropped: number;
  signedIn: boolean;
  idle: TimerHandle | null;
}

const codeOf = (error: unknown): ErrorCode => (error instanceof PapError ? error.code : "helper_failed");

/**
 * The live sign-in flows (M7R59): at most 2 per owner and 1 per provider, each owned by the user who started it. A flow
 * ends on done, a cancel, its 10-minute deadline, or 60 s without a subscriber. Nothing a helper says reaches the stream
 * unless `LoginEvent` accepts it, and nothing of an answer is logged or kept here: it goes to the helper and no further.
 */
export function createLoginFlows(deps: LoginFlowsDeps) {
  const { clock, logger } = deps;
  const flows = new Map<string, Flow>();

  const ownFlow = (ownerId: string, flowId: string): Flow => {
    const flow = flows.get(flowId);
    if (!flow || flow.ownerId !== ownerId) throw new PapError("not_found");
    return flow;
  };
  const publish = (flow: Flow, event: LoginEvent): void => {
    try {
      deps.publisher.publish(flow.id, event);
    } catch (error) {
      logger.error("login_publish_failed", { provider: flow.provider, err: error });
    }
  };

  /** 60 s without a subscriber ends the flow: armed at the start and again whenever the last subscriber leaves. */
  const armIdle = (flow: Flow): void => {
    if (flow.idle) clock.clearTimeout(flow.idle);
    flow.idle = clock.setTimeout(() => {
      flow.idle = null;
      if (!flow.attached) abort(flow, "timeout");
    }, LOGIN_LIMITS.idleMs);
  };

  /** The credential is stored: audit it once, whatever happened to the flow meanwhile (a cancel can race the helper). */
  function reportSignedIn(flow: Flow): void {
    if (flow.signedIn) return;
    flow.signedIn = true;
    try {
      deps.onSignedIn({ ownerId: flow.ownerId, provider: flow.provider, method: flow.method });
    } catch {
      // The credential is stored either way; a failing audit must neither leave the flow live nor go unseen.
      deps.logger.warn("login_sign_in_report_failed", { provider: flow.provider });
    }
  }
  function conclude(flow: Flow, ok: boolean, code?: ErrorCode): void {
    if (flow.ended) return;
    flow.ended = true;
    if (flow.idle) clock.clearTimeout(flow.idle);
    flow.idle = null;
    publish(flow, { kind: "done", ok, ...(code === undefined ? {} : { code }) });
    if (ok) reportSignedIn(flow);
    const ended = [...flows.values()].filter((entry) => entry.ended);
    for (const old of ended.slice(0, Math.max(0, ended.length - LOGIN_LIMITS.retained))) {
      flows.delete(old.id);
      deps.publisher.forget(old.id);
    }
  }
  /** The helper misbehaved: stop it and say so. */
  function abort(flow: Flow, code: ErrorCode): void {
    conclude(flow, false, code);
    flow.handle?.cancel();
  }
  function drop(flow: Flow, what: "event" | "prompt"): void {
    flow.dropped += 1;
    // The reason only: what the helper sent may be a provider's or an extension's text and is not logged (R66).
    logger.warn("login_event_dropped", { provider: flow.provider, what, dropped: flow.dropped });
    if (flow.dropped >= LOGIN_LIMITS.maxDropped) abort(flow, "helper_failed");
  }

  function onEvent(flow: Flow, raw: unknown): void {
    if (flow.ended) return;
    const parsed = LoginEvent.safeParse(raw);
    // Prompts and the end of a flow are the daemon's to announce: a helper cannot claim them as events.
    if (!parsed.success || parsed.data.kind === "prompt" || parsed.data.kind === "done")
      return drop(flow, "event");
    publish(flow, parsed.data);
  }
  function onPrompt(flow: Flow, promptId: string, raw: unknown): void {
    if (flow.ended) return;
    const parsed = LoginPrompt.safeParse(raw);
    if (!parsed.success) {
      flow.handle?.answer(promptId, null);
      return drop(flow, "prompt");
    }
    publish(flow, { kind: "prompt", promptId, prompt: parsed.data });
  }

  return {
    /** Throws `capacity` (2 live flows for the owner) or `pi_busy` (a full pool: a sign-in never queues) or `conflict` (a live flow for the provider). */
    start(ownerId: string, provider: string, method: LoginMethod): string {
      const live = [...flows.values()].filter((flow) => !flow.ended);
      if (live.filter((flow) => flow.ownerId === ownerId).length >= LOGIN_LIMITS.perOwner)
        throw new PapError("capacity");
      if (live.some((flow) => flow.provider === provider)) throw new PapError("conflict");
      const flow: Flow = {
        id: deps.newId(),
        ownerId,
        provider,
        method,
        handle: null,
        ended: false,
        cancelled: false,
        attached: false,
        dropped: 0,
        signedIn: false,
        idle: null,
      };
      // The pool refuses with `pi_busy` before anything exists; nothing between the checks above and the entry below awaits.
      const handle = deps.helpers.run(
        "auth.login",
        { provider, method },
        {
          deadlineMs: LOGIN_LIMITS.deadlineMs,
          onEvent: (event) => onEvent(flow, event),
          onPrompt: (promptId, prompt) => onPrompt(flow, promptId, prompt),
        },
      );
      flow.handle = handle;
      flows.set(flow.id, flow);
      armIdle(flow);
      handle.done.then(
        (result) => {
          if (HELPER_OPS["auth.login"].result.safeParse(result).success) {
            conclude(flow, true);
            reportSignedIn(flow);
          } else abort(flow, "helper_failed");
        },
        (error: unknown) => conclude(flow, false, flow.cancelled ? undefined : codeOf(error)),
      );
      return flow.id;
    },
    /** `not_found`: not the caller's flow, or no such prompt is open. */
    answer(ownerId: string, flowId: string, promptId: string, value: string): void {
      const flow = ownFlow(ownerId, flowId);
      if (flow.ended || !flow.handle?.answer(promptId, value)) throw new PapError("not_found");
    },
    cancel(ownerId: string, flowId: string): void {
      const flow = ownFlow(ownerId, flowId);
      if (flow.ended) return;
      flow.cancelled = true;
      conclude(flow, false);
      flow.handle?.cancel();
    },
    /** The caller's own live flow for `provider`: `not_found` when there is none (another user's flow is none). */
    cancelByProvider(ownerId: string, provider: string): void {
      const flow = [...flows.values()].find(
        (entry) => !entry.ended && entry.ownerId === ownerId && entry.provider === provider,
      );
      if (!flow) throw new PapError("not_found");
      this.cancel(ownerId, flow.id);
    },
    /** A subscriber exists: the flow is no longer idle. Checks ownership, like every other call. */
    attach(ownerId: string, flowId: string): void {
      const flow = ownFlow(ownerId, flowId);
      flow.attached = true;
      if (flow.idle) clock.clearTimeout(flow.idle);
      flow.idle = null;
    },
    /**
     * The last subscriber left (a reload, a closed tab; the hub tells, MC31): the 60 s rule applies again. The caller is
     * the hub, not a user, so there is no owner to check; an ended or unknown flow has nothing to arm.
     */
    detach(flowId: string): void {
      const flow = flows.get(flowId);
      if (!flow || flow.ended || !flow.attached) return;
      flow.attached = false;
      armIdle(flow);
    },
    /** The caller's flow, or `not_found`: what a subscription is checked against before it opens. */
    check(ownerId: string, flowId: string): void {
      ownFlow(ownerId, flowId);
    },
  };
}
