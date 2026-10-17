import { createHash } from "node:crypto";
import type { Clock } from "../../../kernel/clock.ts";
import type { Logger } from "../../../kernel/logger.ts";
import { blockedForPush } from "../../../kernel/net/address-push.ts";
import type { PushReadiness } from "../../../kernel/push-readiness.ts";
import type { PushTransport, SendOutcome, SubscriptionTarget } from "../service.ts";
import { encryptPayload } from "./encrypt.ts";
import { endpointRefusal, type HostRule } from "./endpoint.ts";
import { authSecretOf, validPublicPoint } from "./point.ts";
import { sendOnce, type Resolver, type SendResult } from "./sender.ts";
import { endpointTag } from "../endpoint-tag.ts";
import type { VapidState } from "./vapid.ts";

export interface HttpsTransportDeps {
  /** Null when the database is read-only and no key was loaded. */
  readonly vapid: VapidState | null;
  /** The VAPID `sub` claim (M12R5), already derived from the config. */
  readonly subject: string;
  readonly readiness: PushReadiness;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly loopbackForTests: boolean;
  /** The built-in push-service list plus the owner's extras: the endpoint is judged again at send time. */
  readonly hosts: readonly HostRule[];
  /** Tests only: replaces the address check (default: nothing `blockedForPush` refuses). */
  readonly allowAddress?: (ip: string) => boolean;
  /** Tests only: replaces DNS. */
  readonly lookup?: Resolver;
}

const MAX_RETRY_AFTER_MS = 3_600_000;
const MAX_HOSTS = 64;
const DAY_MS = 24 * 3600_000;
const TOPIC = /^[A-Za-z0-9_-]{1,32}$/; // RFC 8030 section 5.4
const ENCRYPT_REFUSALS = new Set(["payload_too_large", "bad_keys"]);
const refused = (reason: string): SendOutcome => ({ kind: "refused", reason });

function retryAfterMs(header: string | null): number | undefined {
  if (header === null || !/^\d{1,9}$/.test(header)) return undefined; // seconds only; a date is ignored
  return Math.min(Number(header) * 1000, MAX_RETRY_AFTER_MS);
}

function outcomeOf(result: SendResult): SendOutcome {
  if ("error" in result) return result.error === "address" ? refused("address") : { kind: "retry" };
  const { status } = result;
  if (status === 200 || status === 201 || status === 202) return { kind: "ok" };
  if (status === 404 || status === 410) return { kind: "gone" };
  if (status === 429 || status >= 500) {
    const afterMs = retryAfterMs(result.retryAfter);
    return afterMs === undefined ? { kind: "retry" } : { kind: "retry", afterMs };
  }
  return { kind: "rejected", status }; // 400, 401, 403, 413, every 3xx (none is followed), anything else
}

const label = (outcome: SendOutcome, result: SendResult | null): string => {
  if (outcome.kind === "refused") return `refused:${outcome.reason}`;
  return result !== null && "error" in result && outcome.kind === "retry"
    ? `retry:${result.error}`
    : outcome.kind;
};

/**
 * The real transport (M12R6, R8): encrypts, signs, and sends one POST through the guarded sender. It never throws:
 * every failure is an outcome. A send logs the endpoint hash, the outcome and the status; an internal error adds its
 * class name (`err.name`). Nothing else: no endpoint, key, payload or response body.
 */
export function createHttpsTransport(deps: HttpsTransportDeps): PushTransport {
  const { vapid, logger, clock } = deps;
  const allowAddress = deps.allowAddress ?? ((ip: string) => !blockedForPush(ip));
  // Per push-service host (the endpoint rules keep this to a handful): rejections since that host was last logged.
  const keyRejected = new Map<string, { count: number; loggedAt: number }>();

  function noteKeyRejected(host: string): void {
    if (!keyRejected.has(host) && keyRejected.size >= MAX_HOSTS) keyRejected.clear(); // bounded: full means start over
    const entry = keyRejected.get(host) ?? { count: 0, loggedAt: -Infinity };
    entry.count += 1;
    keyRejected.set(host, entry);
    if (clock.now() - entry.loggedAt < DAY_MS) return;
    entry.loggedAt = clock.now();
    // M12R4: a changed key shows up here. The host as a hash, never the endpoint; at most one line a day for each host.
    logger.warn("push_key_rejected", {
      count: entry.count,
      host: `h:${createHash("sha256").update(host).digest("hex").slice(0, 12)}`,
    });
    entry.count = 0;
  }

  const status: PushTransport["status"] = () => {
    if (vapid === null) return { on: false, reason: null, publicKey: null };
    if (vapid.kind === "off") return { on: false, reason: vapid.reason, publicKey: null };
    const publicKey = vapid.identity.publicKey;
    if (deps.readiness.status === "insecure_http") return { on: false, reason: "insecure_http", publicKey };
    return { on: true, reason: null, publicKey };
  };

  async function attempt(
    target: SubscriptionTarget,
    plaintext: Uint8Array,
    opts: Parameters<PushTransport["send"]>[2],
    signal: AbortSignal,
  ): Promise<{ outcome: SendOutcome; result: SendResult | null; host: string }> {
    const no = (outcome: SendOutcome) => ({ outcome, result: null, host: "" });
    if (vapid === null || vapid.kind !== "ready" || !status().on) return no(refused("off"));
    // the rules of now, not of the day it was stored: net.connect skips the lookup hook for an IP literal
    const check = endpointRefusal(target.endpoint, {
      hosts: deps.hosts,
      loopbackForTests: deps.loopbackForTests,
    });
    if (!check.ok) return no(refused("endpoint"));
    if (!TOPIC.test(opts.topic)) return no(refused("bad_topic"));
    const authSecret = authSecretOf(target.auth);
    if (!validPublicPoint(target.p256dh) || authSecret === null) return no(refused("bad_keys"));
    let body: Buffer;
    try {
      body = encryptPayload(plaintext, Buffer.from(target.p256dh, "base64url"), authSecret);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY") return no(refused("bad_keys"));
      if (error instanceof RangeError && ENCRYPT_REFUSALS.has(error.message))
        return no(refused(error.message));
      throw error;
    }
    const url = new URL(check.href);
    const authorization = `vapid ${vapid.identity.sign(url.origin, deps.subject, clock.now())}`;
    const result = await sendOnce({
      href: check.href,
      body,
      headers: {
        authorization,
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(Math.max(0, Math.floor(opts.ttlSeconds))),
        urgency: opts.urgency,
        topic: opts.topic,
      },
      signal,
      allowLoopback: deps.loopbackForTests,
      clock,
      allowAddress,
      ...(deps.lookup ? { resolve: deps.lookup } : {}),
    });
    return { outcome: outcomeOf(result), result, host: check.host };
  }

  return {
    status,
    async send(target, plaintext, opts, signal) {
      let tag = "h:unknown";
      try {
        tag = endpointTag(target.endpoint);
        const { outcome, result, host } = await attempt(target, plaintext, opts, signal);
        if (result !== null && "status" in result) {
          if (result.status === 401 || result.status === 403) noteKeyRejected(host);
          logger.info("push_send", { h: tag, outcome: label(outcome, result), status: result.status });
        } else {
          logger.info("push_send", { h: tag, outcome: label(outcome, result), status: null });
        }
        return outcome;
      } catch (error) {
        logger.warn("push_send", {
          h: tag,
          outcome: "refused:internal",
          status: null,
          error: error instanceof Error ? error.name : "unknown",
        });
        return refused("internal");
      }
    },
  };
}
