import { getConnInfo } from "@hono/node-server/conninfo";
import { PapError, type ErrorCode } from "@pap/contracts";
import type { Context, Hono, Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  deviceCookieOptions,
  readCookie,
  readCookies,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionCookieAttributes,
} from "./cookies.ts";
import { DEVICE_COOKIE } from "./known-device.ts";
import { isAcceptablePassword } from "./passwords.ts";
import { RateLimitedError, USERNAME_PATTERN, type AuthService, type StartedSession } from "./service.ts";

const MAX_BODY_BYTES = 16 * 1024;
const Username = z.string().regex(USERNAME_PATTERN);
const Password = z.string().refine(isAcceptablePassword);
const SetupBody = z.object({ token: z.string().min(1).max(256), username: Username, password: Password });
const ConfirmBody = z.object({ password: z.string().min(1).max(1024) });
const LoginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(1024) });

export async function readJson<T>(c: Context, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const parsed = schema.safeParse(await c.req.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Every client error carries a code and nothing else: no field name, no value, never the password (decision 34).
export const badRequest = (c: Context): Response => c.json({ error: { code: "bad_request" } }, 400);

const STATUS_OF: Partial<Record<ErrorCode, 401 | 403 | 404 | 409>> = {
  unauthenticated: 401,
  account_disabled: 403,
  conflict: 409,
  not_found: 404,
};

export function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof RateLimitedError) {
    c.header("retry-after", String(Math.ceil(error.retryAfterMs / 1000)));
    return c.json({ error: { code: error.code } }, 429);
  }
  if (error instanceof PapError) return c.json({ error: { code: error.code } }, STATUS_OF[error.code] ?? 400);
  throw error;
}

export const sessionCookie = (c: Context): string | undefined =>
  readCookie(c.req.header("cookie"), SESSION_COOKIE);

// Set per request by the middleware of mountAuthRoutes. Only an explicit false allows a cookie without Secure,
// so a route mounted without it fails closed.
const SECURE_BY_CONFIG = "secureByConfig";
const INSECURE_HTTP = "insecureHttp";
const cookieAttributes = (c: Context) =>
  sessionCookieAttributes(c.req.url, c.get(SECURE_BY_CONFIG) !== false, c.get(INSECURE_HTTP) === true);
const deviceCookieAttributes = (c: Context) =>
  deviceCookieOptions(c.req.url, c.get(SECURE_BY_CONFIG) !== false, c.get(INSECURE_HTTP) === true);

/** Every `pap_device` value of the request: the first that validates is the one that counts. */
export const deviceCookie = (c: Context): string[] => readCookies(c.req.header("cookie"), DEVICE_COOKIE);

export function setSessionCookie(c: Context, session: StartedSession): void {
  setCookie(c, SESSION_COOKIE, session.cookieValue, {
    ...cookieAttributes(c),
    maxAge: session.maxAgeSeconds,
  });
  if (session.deviceCookie !== undefined) {
    setCookie(c, DEVICE_COOKIE, session.deviceCookie, deviceCookieAttributes(c));
  }
}

// The address of the socket, never a forwarded header (R72). Without one every caller shares a single bucket.
export function clientIp(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

// Setup and login end alike: read the body, start a session, hand the browser its cookie.
async function startSessionFrom<T>(
  c: Context,
  schema: z.ZodType<T>,
  start: (body: T) => Promise<StartedSession>,
  status: 200 | 201,
): Promise<Response> {
  const body = await readJson(c, schema);
  if (!body) return badRequest(c);
  try {
    setSessionCookie(c, await start(body));
    return c.json({ ok: true }, status);
  } catch (error) {
    return errorResponse(c, error);
  }
}

export function mountAuthRoutes(
  app: Hono,
  deps: { service: AuthService; passkeysAvailable: boolean; secureByConfig: boolean; insecureHttp?: boolean },
): void {
  const client = (c: Context) => ({
    ip: clientIp(c),
    userAgent: c.req.header("user-agent"),
    deviceCookie: deviceCookie(c),
  });
  app.use("/auth/*", async (c: Context, next: Next) => {
    c.set(SECURE_BY_CONFIG, deps.secureByConfig);
    c.set(INSECURE_HTTP, deps.insecureHttp === true);
    c.header("cache-control", "no-store");
    await next();
  });
  app.use("/auth/*", bodyLimit({ maxSize: MAX_BODY_BYTES }));
  app.get("/auth/status", (c) => {
    const cookieValue = sessionCookie(c);
    const status = deps.service.status(cookieValue);
    // The server slides the session; the browser's copy only slides if it is told, so renew it here.
    if (status.authenticated && cookieValue) {
      setSessionCookie(c, { cookieValue, maxAgeSeconds: SESSION_TTL_MS / 1000 });
    }
    return c.json({ ...status, passkeysAvailable: deps.passkeysAvailable });
  });
  app.post("/auth/setup", (c) =>
    startSessionFrom(c, SetupBody, (body) => deps.service.setup({ ...body, ...client(c) }), 201),
  );
  app.post("/auth/login", (c) =>
    startSessionFrom(c, LoginBody, (body) => deps.service.login({ ...body, ...client(c) }), 200),
  );
  app.post("/auth/confirm", async (c) => {
    const body = await readJson(c, ConfirmBody);
    if (!body) return badRequest(c);
    try {
      await deps.service.confirmSession({
        cookieValue: sessionCookie(c),
        password: body.password,
        ip: clientIp(c),
      });
      return c.body(null, 204);
    } catch (error) {
      return errorResponse(c, error);
    }
  });
  app.post("/auth/logout", (c) => {
    deps.service.logout(sessionCookie(c));
    deleteCookie(c, SESSION_COOKIE, cookieAttributes(c));
    return c.body(null, 204);
  });
}
