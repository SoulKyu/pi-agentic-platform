import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export { HOOK_PATH, isHookRequest } from "../../kernel/http/hook-path.ts";
export const HOOK_BODY_MAX_BYTES = 65_536;
export const HOOK_READ_MS = 10_000;

/** 32 random bytes; shown once at creation or rotation, kept in `secrets/triggers/<id>.key` (0600), never in the database. */
export const newHookSecret = (): string => `pwh_${randomBytes(32).toString("base64url")}`;
export const HOOK_SECRET = /^pwh_[A-Za-z0-9_-]{43}$/;

const digest = (value: string | Uint8Array): Buffer => createHash("sha256").update(value).digest();

/** Constant time whatever the lengths: both sides are hashed first (T3 `webhookVerification.ts`). */
export function sameSecret(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

export interface HeaderReader {
  get(name: string): string | null;
}

const BEARER = /^bearer ([!-~]{1,256})$/i;

/**
 * The secret a request presents: `Authorization: Bearer <secret>` (Alertmanager's `http_config.authorization`,
 * Grafana's header; the scheme in any case, RFC 7235) or `X-Pap-Secret: <secret>`. An Authorization that is not a
 * Bearer (Basic credentials for a proxy in front of pap) is ignored beside `X-Pap-Secret`, and alone presents "" (a
 * wrong secret). Two different secrets are refused as a whole. null: nothing presented.
 */
export function presentedSecret(headers: HeaderReader): string | null {
  const authorization = headers.get("authorization");
  const own = headers.get("x-pap-secret");
  const bearer = authorization === null ? null : (BEARER.exec(authorization)?.[1] ?? null);
  if (bearer !== null && own !== null) return bearer === own ? bearer : "";
  if (bearer !== null) return bearer;
  if (own !== null) return own;
  return authorization === null ? null : "";
}

/** `secret` mode, before a byte of the body is read. An `hmac` trigger has nothing to check here. */
export function secretAccepted(mode: "secret" | "hmac", headers: HeaderReader, secret: string): boolean {
  if (mode === "hmac") return true;
  const given = presentedSecret(headers);
  return given !== null && sameSecret(given, secret);
}

const SIGNATURE = /^(?:sha256=)?([0-9a-fA-F]{64})$/;

/** HMAC-SHA256 of the raw body under the secret, hex, with or without `sha256=` (GitHub, Grafana without timestamp). */
export function signatureAccepted(header: string | null, secret: string, body: Uint8Array): boolean {
  if (header === null) return false;
  const match = SIGNATURE.exec(header.trim());
  if (!match?.[1]) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(Buffer.from(match[1].toLowerCase(), "hex"), expected);
}

/**
 * Reads at most `max` bytes from the body as it streams: the declared length is not trusted, and one byte more is
 * `too_large` at once (the rest is never read). `unreadable`: the client went away or stalled past `deadlineMs`.
 */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number,
  wait: (ms: number) => { promise: Promise<void>; cancel(): void },
  deadlineMs: number,
): Promise<Uint8Array | "too_large" | "unreadable"> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const timer = wait(deadlineMs);
  const expired = timer.promise.then(() => "expired" as const);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), expired]);
      if (next === "expired") {
        void reader.cancel().catch(() => undefined);
        return "unreadable";
      }
      if (next.done) break;
      size += next.value.byteLength;
      if (size > max) {
        void reader.cancel().catch(() => undefined);
        return "too_large";
      }
      chunks.push(next.value);
    }
  } catch {
    return "unreadable";
  } finally {
    timer.cancel();
  }
  return Buffer.concat(chunks, size);
}

/** A Content-Length over the cap is refused before a byte is read; a missing or odd one is left to `readCapped`. */
export function declaredTooLarge(contentLength: string | null, max: number): boolean {
  return contentLength !== null && /^\d{1,15}$/.test(contentLength) && Number(contentLength) > max;
}

/** The dedup key of a delivery: the alert identity for the alert formats, else the exact body (replays included). */
export function dedupKeyOf(identity: string | null, body: Uint8Array): string {
  return createHash("sha256")
    .update(identity ?? body)
    .digest("hex");
}
