import { PapError } from "@pap/contracts";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { sha256Hex } from "../../kernel/ids.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import {
  badRequest,
  clientIp,
  deviceCookie,
  errorResponse,
  readJson,
  sessionCookie,
  setSessionCookie,
} from "./http.ts";
import type { KnownDevices } from "./known-device.ts";
import type { PasskeyService } from "./passkeys.ts";
import { RateLimitedError, type AuthService } from "./service.ts";
import { ipKey, sessionKey } from "./throttle-keys.ts";
import { MAX_BACKOFF_MS, type Throttle } from "./throttle.ts";

// A sign-in flow id is the 75-character challenge itself.
const FlowBody = z.object({
  flowId: z.string().min(1).max(128),
  response: z.record(z.string(), z.unknown()),
});
// WebAuthn credential ids are at most 1023 bytes, 1364 base64url characters: a longer one cannot be ours.
const MAX_CREDENTIAL_ID = 1400;
const EnrollBody = z.object({ password: z.string().min(1).max(1024) });

export interface PasskeyRouteDeps {
  readonly passkeys: PasskeyService;
  readonly auth: AuthService;
  /**
   * Its own instance, never the password keys (R80, R81). Keys: the socket address, or `device:` for a browser whose
   * cookie was issued to the credential's user. It evicts, so a spray can only loosen a limit, never lock anybody.
   */
  readonly throttle: Throttle;
  readonly devices: KnownDevices;
  /** The user a credential id belongs to, looked up before anything is verified. */
  readonly userOfPasskey: (credentialId: string) => string | undefined;
  readonly logger: Logger;
  readonly audit: Pick<AuditPort, "append">;
}

// The attempt is counted before the slow verification, so parallel guesses queue behind the first instead of
// all passing the guard (as for passwords); a success clears the count. Logged with the address and the delay
// now in force, nothing else. A request with a body we cannot read, or a 404, is not an attempt.
async function throttled<T>(
  c: Context,
  deps: PasskeyRouteDeps,
  run: () => Promise<T>,
  throttle: Throttle,
  keys: string[],
): Promise<T> {
  if (!deps.passkeys.available) throw new PapError("not_found");
  const ip = clientIp(c);
  const wait = throttle.retryAfterMs(keys);
  if (wait > 0) throw new RateLimitedError(wait);
  if (!throttle.fail(keys)) throw new RateLimitedError(MAX_BACKOFF_MS);
  try {
    const result = await run();
    throttle.succeed(keys);
    return result;
  } catch (error) {
    if (error instanceof PapError && error.code === "unauthenticated") {
      deps.logger.warn("auth_passkey_failed", { ip, retryAfterMs: throttle.retryAfterMs(keys) });
    }
    // A credential that is already registered was recognised, not guessed: it leaves no step behind.
    if (error instanceof PapError && error.code === "conflict") throttle.succeed(keys);
    throw error;
  }
}

// Mount after mountAuthRoutes: its middleware on /auth/* sets the cookie policy, no-store and the body limit.
export function mountPasskeyRoutes(app: Hono, deps: PasskeyRouteDeps): void {
  const caller = (c: Context) => deps.auth.authenticate(sessionCookie(c));
  const unauthenticated = (c: Context) => errorResponse(c, new PapError("unauthenticated"));
  app.post("/auth/passkey/register/options", async (c) => {
    const owner = caller(c);
    const cookie = sessionCookie(c);
    if (!owner || !cookie) return unauthenticated(c);
    // Nothing to enroll on an IP-address origin: do not spend a password attempt on it.
    if (!deps.passkeys.available) return errorResponse(c, new PapError("not_found"));
    const body = await readJson(c, EnrollBody);
    if (!body) return badRequest(c);
    try {
      // R83: a session alone must not add a credential that outlives it (a stolen cookie, ADR 0004). The
      // password is checked like a sign-in before any flow exists, but counted on the session's own key (M5R127).
      await deps.auth.confirmPassword({
        userId: owner.userId,
        password: body.password,
        ip: clientIp(c),
        throttleKey: sessionKey(cookie),
      });
      return c.json(await deps.passkeys.registerOptions(owner.userId, sha256Hex(cookie)));
    } catch (error) {
      return errorResponse(c, error);
    }
  });
  app.post("/auth/passkey/register/verify", async (c) => {
    const owner = caller(c);
    const cookie = sessionCookie(c);
    if (!owner || !cookie) return unauthenticated(c);
    const body = await readJson(c, FlowBody);
    if (!body) return badRequest(c);
    try {
      await throttled(
        c,
        deps,
        () => deps.passkeys.registerVerify(owner.userId, sha256Hex(cookie), body.flowId, body.response),
        deps.throttle,
        [sessionKey(cookie)],
      );
      deps.logger.info("auth_passkey_enrolled", { ip: clientIp(c) });
      deps.audit.append({ ownerId: owner.userId, actor: "user", kind: "auth", reason: "passkey_enrolled" });
      return c.json({ ok: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  });
  app.post("/auth/passkey/login/options", async (c) => {
    try {
      return c.json(await deps.passkeys.loginOptions());
    } catch (error) {
      return errorResponse(c, error);
    }
  });
  app.post("/auth/passkey/login/verify", async (c) => {
    const body = await readJson(c, FlowBody);
    if (!body) return badRequest(c);
    try {
      const sent = body.response.id;
      const claimed =
        typeof sent === "string" && sent.length <= MAX_CREDENTIAL_ID ? deps.userOfPasskey(sent) : undefined;
      const device = deps.devices.keyOf(deviceCookie(c), claimed);
      const { userId, passkeyRef } = await throttled(
        c,
        deps,
        () => deps.passkeys.loginVerify(body.flowId, body.response),
        deps.throttle,
        [device ?? ipKey(clientIp(c))],
      );
      // Always a new session, never the one the request came with: a cookie planted beforehand gains nothing.
      setSessionCookie(
        c,
        deps.auth.startSession(userId, c.req.header("user-agent"), {
          ip: clientIp(c),
          method: "passkey",
          passkeyRef,
          deviceCookie: deviceCookie(c),
        }),
      );
      return c.json({ ok: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  });
}
