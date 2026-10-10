import { PapError } from "@pap/contracts";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Logger } from "../../kernel/logger.ts";
import { badRequest, clientIp, errorResponse, readJson, sessionCookie, setSessionCookie } from "./http.ts";
import type { PasskeyService } from "./passkeys.ts";
import { RateLimitedError, type AuthService } from "./service.ts";
import type { Throttle } from "./throttle.ts";

const FlowBody = z.object({
  flowId: z.string().min(1).max(64),
  response: z.record(z.string(), z.unknown()),
});

export interface PasskeyRouteDeps {
  readonly passkeys: PasskeyService;
  readonly auth: AuthService;
  /** Its own instance, keyed by socket address only: never the password keys (R80, R81). */
  readonly throttle: Throttle;
  readonly logger: Logger;
}

// A verification that fails counts against the sender's address and is logged with the address and the
// delay now in force, nothing else. A request with a body we cannot read, or a 404, is not a failure.
async function throttled<T>(c: Context, deps: PasskeyRouteDeps, run: () => Promise<T>): Promise<T> {
  const ip = clientIp(c);
  const keys = [`ip:${ip}`];
  const wait = deps.throttle.retryAfterMs(keys);
  if (wait > 0) throw new RateLimitedError(wait);
  try {
    const result = await run();
    deps.throttle.succeed(keys);
    return result;
  } catch (error) {
    if (error instanceof PapError && error.code === "unauthenticated") {
      deps.throttle.fail(keys);
      deps.logger.warn("auth_passkey_failed", { ip, retryAfterMs: deps.throttle.retryAfterMs(keys) });
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
    if (!owner) return unauthenticated(c);
    try {
      return c.json(await deps.passkeys.registerOptions(owner.userId));
    } catch (error) {
      return errorResponse(c, error);
    }
  });
  app.post("/auth/passkey/register/verify", async (c) => {
    const owner = caller(c);
    if (!owner) return unauthenticated(c);
    const body = await readJson(c, FlowBody);
    if (!body) return badRequest(c);
    try {
      await throttled(c, deps, () => deps.passkeys.registerVerify(owner.userId, body.flowId, body.response));
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
      const userId = await throttled(c, deps, () => deps.passkeys.loginVerify(body.flowId, body.response));
      // Always a new session, never the one the request came with: a cookie planted beforehand gains nothing.
      setSessionCookie(c, deps.auth.startSession(userId, c.req.header("user-agent")));
      return c.json({ ok: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  });
}
