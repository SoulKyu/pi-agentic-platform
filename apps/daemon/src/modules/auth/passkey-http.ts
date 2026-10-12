import { PapError } from "@pap/contracts";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Logger } from "../../kernel/logger.ts";
import { badRequest, clientIp, errorResponse, readJson, sessionCookie, setSessionCookie } from "./http.ts";
import type { PasskeyService } from "./passkeys.ts";
import { RateLimitedError, type AuthService } from "./service.ts";
import { sessionKey } from "./throttle-keys.ts";
import type { Throttle } from "./throttle.ts";

// A sign-in flow id is the 75-character challenge itself.
const FlowBody = z.object({
  flowId: z.string().min(1).max(128),
  response: z.record(z.string(), z.unknown()),
});
const EnrollBody = z.object({ password: z.string().min(1).max(1024) });

export interface PasskeyRouteDeps {
  readonly passkeys: PasskeyService;
  readonly auth: AuthService;
  /** Its own instance, keyed by socket address only: never the password keys (R80, R81). */
  readonly throttle: Throttle;
  readonly logger: Logger;
}

// A verification that fails counts against the sender's address and is logged with the address and the
// delay now in force, nothing else. A request with a body we cannot read, or a 404, is not a failure.
async function throttled<T>(
  c: Context,
  deps: PasskeyRouteDeps,
  run: () => Promise<T>,
  throttle: Throttle,
  keys: string[],
): Promise<T> {
  const ip = clientIp(c);
  const wait = throttle.retryAfterMs(keys);
  if (wait > 0) throw new RateLimitedError(wait);
  try {
    const result = await run();
    throttle.succeed(keys);
    return result;
  } catch (error) {
    if (error instanceof PapError && error.code === "unauthenticated") {
      throttle.fail(keys);
      deps.logger.warn("auth_passkey_failed", { ip, retryAfterMs: throttle.retryAfterMs(keys) });
    }
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
      return c.json(await deps.passkeys.registerOptions(owner.userId));
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
        () => deps.passkeys.registerVerify(owner.userId, body.flowId, body.response),
        deps.throttle,
        [sessionKey(cookie)],
      );
      deps.logger.info("auth_passkey_enrolled", { ip: clientIp(c) });
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
      const { userId, passkeyRef } = await throttled(
        c,
        deps,
        () => deps.passkeys.loginVerify(body.flowId, body.response),
        deps.throttle,
        [`ip:${clientIp(c)}`],
      );
      // Always a new session, never the one the request came with: a cookie planted beforehand gains nothing.
      setSessionCookie(
        c,
        deps.auth.startSession(userId, c.req.header("user-agent"), {
          ip: clientIp(c),
          method: "passkey",
          passkeyRef,
        }),
      );
      return c.json({ ok: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  });
}
