import type { Context, Hono } from "hono";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { type Backoff, createBackoff } from "./backoff.ts";
import type { Engine } from "./engine.ts";
import {
  declaredTooLarge,
  dedupKeyOf,
  HOOK_BODY_MAX_BYTES,
  HOOK_PATH,
  HOOK_READ_MS,
  readCapped,
  secretAccepted,
  signatureAccepted,
} from "./hook-auth.ts";
import type { HookJournal, HookTarget } from "./hook-journal.ts";
import { createHookRate, type HookRate } from "./hook-rate.ts";
import { createHookSlots, type HookSlots } from "./hook-slots.ts";
import { mapPayload } from "./payload.ts";
import { readTriggerSecret } from "./trigger-secrets.ts";
import type { TriggerRecord } from "./triggers.ts";

export interface HooksDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  /** A database written by a newer pap: the route answers `503 read_only` before anything else (M10R150). */
  readonly readOnly: boolean;
  readonly secretsDir: string;
  /** The trigger by id, whoever owns it: the route has no caller (the secret is the credential). */
  find(triggerId: string): TriggerRecord | null;
  readonly fire: Engine["fire"];
  readonly slots?: HookSlots;
  readonly backoff?: Backoff;
  readonly rate?: HookRate;
  /** The lines of refusals the route itself writes; none: nothing is journaled (unit tests of the route). */
  readonly journal?: HookJournal;
}

const JSON_TYPE = /^application\/(?:[\w.-]+\+)?json\s*(?:;|$)/i;

type Refusal = "unauthenticated" | "payload_too_large" | "bad_request";
const STATUS = { unauthenticated: 401, payload_too_large: 413, bad_request: 400 } as const;

/**
 * `POST /hooks/<trigger id>` (spec C §6.4, § "The webhook at a glance"). Outside the Origin check, no cookie, no session:
 * the trigger's secret is the credential. Cheap refusals come first, authentication before anything that can refuse an
 * authenticated sender, and the body is counted as it streams. Every answer but 202 closes the connection (RT-02).
 */
export function mountHookRoute(app: Hono, deps: HooksDeps): void {
  const { clock, logger } = deps;
  const slots = deps.slots ?? createHookSlots();
  const backoff = deps.backoff ?? createBackoff(clock);
  const rate = deps.rate ?? createHookRate(clock);

  const wait = (ms: number) => {
    let handle: TimerHandle | undefined;
    const promise = new Promise<void>((resolve) => {
      handle = clock.setTimeout(resolve, ms);
    });
    return { promise, cancel: () => handle && clock.clearTimeout(handle) };
  };

  function answer(c: Context, status: number, body: unknown, retryAfter?: number) {
    c.header("cache-control", "no-store");
    if (status !== 202) c.header("connection", "close");
    if (retryAfter !== undefined) c.header("retry-after", String(retryAfter));
    return c.json(body, status as 202);
  }
  const refuse = (
    c: Context,
    code: Refusal | "not_found" | "capacity" | "read_only" | "internal",
    status: number,
  ) => answer(c, status, { error: { code } });
  const backedOff = (c: Context) => answer(c, 429, { reason: "backoff" }, 60);

  /** A request that did not authenticate (yet): counted, and turned into 429 `backoff` once the trigger is in a block. */
  function failing(
    c: Context,
    key: string | null,
    code: Refusal,
    who?: { target: HookTarget; mode: "secret" | "hmac" },
  ) {
    if (backoff.blocked(key)) return backedOff(c);
    if (backoff.failed(key)) logger.warn("hook_backoff", { scope: key === null ? "unknown" : "trigger" });
    if (who && code === "unauthenticated") deps.journal?.unauthorized(who.target, who.mode);
    return refuse(c, code, STATUS[code]);
  }

  const handle = async (c: Context) => {
    const match = HOOK_PATH.exec(c.req.path);
    const id = match?.[1];
    if (id === undefined) return refuse(c, "not_found", 404);
    if (deps.readOnly) return refuse(c, "read_only", 503);

    const trigger = deps.find(id);
    const source = trigger?.input?.source;
    if (trigger === null || source?.type !== "webhook") {
      if (backoff.failed(null)) logger.warn("hook_unknown_flood", {});
      return refuse(c, "not_found", 404);
    }
    const target = { id, ownerId: trigger.ownerId };
    const who = { target, mode: source.auth };
    const secret = readTriggerSecret(deps.secretsDir, id);
    if (secret === null) return failing(c, id, "unauthenticated", who);

    // Authentication before anything that can refuse an authenticated sender (RT-01).
    const headers = c.req.raw.headers;
    const authenticated = source.auth === "secret";
    if (authenticated && !secretAccepted("secret", headers, secret))
      return failing(c, id, "unauthenticated", who);
    // Once the secret passed, nothing below is a guess: a refusal is the sender's own, never the backoff's.
    const refuseBody = (code: "payload_too_large" | "bad_request") =>
      authenticated ? refuse(c, code, STATUS[code]) : failing(c, id, code);

    if (declaredTooLarge(c.req.header("content-length") ?? null, HOOK_BODY_MAX_BYTES))
      return refuseBody("payload_too_large");
    const release = slots.take(authenticated ? "authenticated" : "unauthenticated", id);
    if (release === null) return refuse(c, "capacity", 503);
    let body: Awaited<ReturnType<typeof readCapped>>;
    try {
      body = await readCapped(c.req.raw.body, HOOK_BODY_MAX_BYTES, wait, HOOK_READ_MS);
    } finally {
      release();
    }
    if (body === "too_large") return refuseBody("payload_too_large");
    if (body === "unreadable") return refuseBody("bad_request");
    if (!authenticated && !signatureAccepted(headers.get(source.hmacHeader), secret, body))
      return failing(c, id, "unauthenticated", who);

    // Authenticated from here: every delivery counts toward the rate, whatever it becomes (M10R55).
    if (rate.count(id) === "rate") {
      deps.journal?.refused(target, "throttle", null);
      return answer(c, 429, { reason: "rate" }, 60);
    }
    const text = new TextDecoder().decode(body);
    let parsed: unknown;
    if (JSON_TYPE.test(headers.get("content-type") ?? "")) {
      try {
        parsed = JSON.parse(text);
      } catch {
        deps.journal?.refused(target, "bad_payload", null);
        return refuse(c, "bad_request", 400);
      }
    }
    const mapped = mapPayload(source.format, parsed, text);

    try {
      const result = deps.fire(trigger.id, trigger.revision, {
        ownerId: trigger.ownerId,
        source: "webhook",
        payload: {
          text: mapped.text,
          source: source.format === "raw" ? "webhook" : source.format,
        },
        precheck: null,
        dedupKey: dedupKeyOf(mapped.identity, body),
        title: trigger.name,
        detail: mapped.detail,
        allResolved: mapped.allResolved,
        gated: true,
        gates: { exemptDisabled: false },
        retry: null,
      });
      switch (result.verdict) {
        case "fired":
          if (result.taskId !== undefined) return answer(c, 202, { taskId: result.taskId });
          break;
        case "disabled":
        case "paused":
        case "resolved":
        case "budget":
        case "dedup":
          return answer(c, 409, { reason: result.verdict });
        case "queue_full":
          return answer(c, 429, { reason: "queue_full" }, 60);
        case "throttle":
          return answer(c, 429, { reason: "rate" }, 60);
        case "error":
          if (result.detail === "changed") return answer(c, 429, { reason: "changed" }, 1);
          if (result.detail === "prompt_too_large") return refuse(c, "payload_too_large", 413);
          break;
        default:
          break;
      }
      logger.error("hook_fire_unexpected", { verdict: result.verdict });
    } catch (error) {
      logger.error("hook_fire_failed", { err: error });
    }
    return refuse(c, "internal", 500);
  };

  // An exception anywhere in the route is answered here, like every other refusal: the app's handler would drop the headers.
  app.post("/hooks/:id", async (c) => {
    try {
      return await handle(c);
    } catch (error) {
      logger.error("hook_failed", { err: error });
      return refuse(c, "internal", 500);
    }
  });
}
