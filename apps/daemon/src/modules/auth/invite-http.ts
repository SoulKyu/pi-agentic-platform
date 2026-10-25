import { InviteAcceptBody, InviteInfoBody, PapError } from "@pap/contracts";
import type { Context, Hono } from "hono";
import type { Logger } from "../../kernel/logger.ts";
import {
  badRequest,
  clientIp,
  deviceCookie,
  errorResponse,
  readJson,
  sessionCookie,
  setSessionCookie,
} from "./http.ts";
import type { Invites } from "./invites.ts";
import { RateLimitedError, type AuthService } from "./service.ts";
import { ipKey } from "./throttle-keys.ts";
import { MAX_BACKOFF_MS, type Throttle } from "./throttle.ts";

export interface InviteRouteDeps {
  readonly invites: Invites;
  readonly auth: Pick<AuthService, "startSession" | "logout">;
  /** Its own table (`invite_throttle`): invitation failures never share the sign-in or setup counts (RT-15). */
  readonly throttle: Throttle;
  readonly logger: Logger;
}

// Both codes are client-visible by design: the page tells the person what to do next.
const FAILURE_STATUS = { invite_invalid: 404, username_taken: 409 } as const;

// Mount after mountAuthRoutes: its middleware on /auth/* sets the cookie policy, no-store and the body limit.
export function mountInviteRoutes(app: Hono, deps: InviteRouteDeps): void {
  const keysOf = (c: Context) => [ipKey(clientIp(c))];
  // Refuses while the address is backing off; a failure is counted by the caller, a success clears the count.
  const guard = (keys: string[]) => {
    const wait = deps.throttle.retryAfterMs(keys);
    if (wait > 0) throw new RateLimitedError(wait);
  };
  const failure = (c: Context, keys: string[], code: keyof typeof FAILURE_STATUS): Response => {
    if (!deps.throttle.fail(keys)) return errorResponse(c, new RateLimitedError(MAX_BACKOFF_MS));
    deps.logger.warn("auth_invite_failed", {
      ip: clientIp(c),
      code,
      retryAfterMs: deps.throttle.retryAfterMs(keys),
    });
    return c.json({ error: { code } }, FAILURE_STATUS[code]);
  };
  app.post("/auth/invite/info", async (c) => {
    const body = await readJson(c, InviteInfoBody);
    if (!body) return badRequest(c);
    const keys = keysOf(c);
    try {
      guard(keys);
      const info = deps.invites.info(body.token);
      return info ? c.json(info) : failure(c, keys, "invite_invalid");
    } catch (error) {
      return errorResponse(c, error);
    }
  });
  app.post("/auth/invite/accept", async (c) => {
    const body = await readJson(c, InviteAcceptBody);
    if (!body) return badRequest(c);
    const keys = keysOf(c);
    try {
      guard(keys);
      const { userId } = await deps.invites.accept(body);
      deps.throttle.succeed(keys);
      // Another user's cookie must not outlive the switch (RT-15): its session goes before the new one starts.
      deps.auth.logout(sessionCookie(c));
      setSessionCookie(
        c,
        deps.auth.startSession(userId, c.req.header("user-agent"), {
          ip: clientIp(c),
          method: "password",
          deviceCookie: deviceCookie(c),
        }),
      );
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof PapError && (error.code === "invite_invalid" || error.code === "username_taken")) {
        return failure(c, keys, error.code);
      }
      return errorResponse(c, error);
    }
  });
}
