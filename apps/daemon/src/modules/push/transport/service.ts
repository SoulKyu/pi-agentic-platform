import {
  PapError,
  PUSH_LIMITS,
  type Caller,
  type PushConfig,
  type PushDeviceView,
  type PushSubscriptionInput,
} from "@pap/contracts";
import type { Clock } from "../../../kernel/clock.ts";
import type { Logger } from "../../../kernel/logger.ts";
import { pushReadiness, type PushReadinessFacts } from "../../../kernel/push-readiness.ts";
import { createRateLimiter } from "../../../kernel/rate-limit.ts";
import type { AuditPort } from "../../audit/index.ts";
import { requireBrowser, type PushTransport } from "../service.ts";
import type { PushMeta } from "./meta.ts";
import type { Subscriptions } from "./store.ts";

export const SUBSCRIBE_WINDOW_MS = 6_000; // one call per window per owner: 10 a minute (M12R9)

export interface TransportServiceDeps {
  readonly store: Subscriptions;
  readonly meta: PushMeta;
  readonly transport: Pick<PushTransport, "status">;
  readonly readiness: PushReadinessFacts;
  readonly clock: Clock;
  readonly audit: Pick<AuditPort, "append">;
  readonly logger: Logger;
  /** A database written by a newer pap: nothing is stored (M12R39). */
  readonly readOnly: boolean;
}

export interface TransportService {
  config(caller: Caller): PushConfig;
  subscribe(caller: Caller, subscription: PushSubscriptionInput): { id: string };
  list(caller: Caller): { items: PushDeviceView[] };
  revoke(caller: Caller, id: string): { ok: true };
}

/**
 * The service behind `push.config`, `push.subscribe`, `push.list` and `push.revoke`. Every method starts with
 * `requireBrowser` (M12R10): a token learns nothing and changes nothing. Owner and credential come from the caller the
 * transport stamped, never from a param.
 */
export function createTransportService(deps: TransportServiceDeps): TransportService {
  const { store, meta } = deps;
  const subscribeLimit = createRateLimiter(deps.clock, SUBSCRIBE_WINDOW_MS);
  const audit = (caller: Caller, reason: string, row: { endpoint: string; host: string }) =>
    deps.audit.append({
      ownerId: caller.userId,
      actor: "user",
      actorId: caller.credentialId,
      kind: "auth",
      reason,
      detail: { endpoint: row.endpoint, host: row.host }, // the hash and the push service's host, never the endpoint
    });
  return {
    config(caller) {
      requireBrowser(caller);
      const status = deps.transport.status();
      const readiness = pushReadiness(deps.readiness);
      return {
        publicKey: status.publicKey,
        status: status.on && !deps.readOnly ? "on" : "off",
        reason: deps.readOnly ? "read_only" : status.reason,
        readiness:
          readiness.status === "ready"
            ? { status: "ready" }
            : { status: readiness.status, hint: readiness.hint },
        subscribed: store.countFor(caller.userId),
        max: PUSH_LIMITS.subscriptionsPerOwner,
        lastFailure: meta.lastFailure(caller.userId),
        keysReset: meta.keysReset(),
      };
    },
    subscribe(caller, subscription) {
      requireBrowser(caller);
      if (deps.readOnly) throw new PapError("read_only");
      // A refusal for a revoked endpoint is free: the Enable that follows it must not meet `rate_limited`.
      if (store.revoked(caller.userId, subscription.endpoint)) throw new PapError("push_revoked");
      if (!subscribeLimit.check(caller.userId).allowed) throw new PapError("rate_limited");
      const { id } = store.add(caller.userId, caller.credentialId, subscription);
      const row = store.describe(caller.userId, id);
      if (row !== null) audit(caller, "push.subscribe", row);
      return { id };
    },
    list(caller) {
      requireBrowser(caller);
      return { items: store.list(caller.userId, caller.credentialId) };
    },
    revoke(caller, id) {
      requireBrowser(caller);
      if (deps.readOnly) throw new PapError("read_only");
      const row = store.describe(caller.userId, id);
      if (row === null || !store.revoke(caller.userId, id)) throw new PapError("not_found");
      audit(caller, "push.revoke", row);
      return { ok: true };
    },
  };
}
