import type { Hono } from "hono";
import { expect } from "vitest";
import type { AuthModule } from "../index.ts";
import { PASSWORD, setupTokenOf, type AuthTestBed } from "./fixture.ts";
import {
  createSoftwareAuthenticator,
  type CeremonyOverrides,
  type SoftwareAuthenticator,
} from "./software-authenticator.ts";

// Drives the real passkey routes with a software authenticator; the real @simplewebauthn/server verifies.
export const LOCAL = "http://localhost:7777";

export interface Daemon {
  readonly bed: AuthTestBed;
  readonly app: Hono;
  readonly auth: AuthModule;
  readonly origin: string;
  readonly authenticator: SoftwareAuthenticator;
}

export function startDaemon(bed: AuthTestBed, origin = LOCAL): Daemon {
  const { app, auth } = bed.start(origin);
  const authenticator = createSoftwareAuthenticator({ origin, rpId: new URL(origin).hostname });
  return { bed, app, auth, origin, authenticator };
}

export async function call(daemon: Daemon, path: string, body?: unknown, cookie?: string) {
  const response = await daemon.app.request(new URL(path, daemon.origin).href, {
    method: "POST",
    headers: { origin: daemon.origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json().catch(() => null)) as Record<string, unknown> | null,
    setCookie: response.headers.get("set-cookie") ?? "",
  };
}

export const cookieOf = (setCookie: string) => setCookie.split(";")[0] ?? "";

export async function ownerCookie(daemon: Daemon): Promise<string> {
  const token = setupTokenOf(daemon.auth);
  const setup = await call(daemon, "/auth/setup", { token, username: "owner", password: PASSWORD });
  expect(setup.status).toBe(201);
  return cookieOf(setup.setCookie);
}

export interface Begun {
  readonly flowId: string;
  readonly options: { challenge: string; user: { id: string } };
}

/** Enrollment needs the session and the password (step-up); a sign-in needs neither. */
export async function begin(daemon: Daemon, kind: "register" | "login", cookie?: string): Promise<Begun> {
  const body = kind === "register" ? { password: PASSWORD } : undefined;
  const response = await call(daemon, `/auth/passkey/${kind}/options`, body, cookie);
  expect(response.status).toBe(200);
  return response.body as unknown as Begun;
}

export async function enroll(daemon: Daemon, cookie: string, overrides?: CeremonyOverrides) {
  const { flowId, options } = await begin(daemon, "register", cookie);
  const response = daemon.authenticator.create(options, overrides);
  return call(daemon, "/auth/passkey/register/verify", { flowId, response }, cookie);
}

/** Waits out the throttle a previous failure may have set, so each call tests its own refusal. */
export async function signIn(daemon: Daemon, overrides?: CeremonyOverrides, cookie?: string) {
  await daemon.bed.clock.advance(61_000);
  const { flowId, options } = await begin(daemon, "login");
  const response = daemon.authenticator.get(options, overrides);
  return {
    ...(await call(daemon, "/auth/passkey/login/verify", { flowId, response }, cookie)),
    flowId,
    response,
  };
}

export const verifyLogin = (daemon: Daemon, flowId: string, response: unknown) =>
  call(daemon, "/auth/passkey/login/verify", { flowId, response });

export const counterOf = (daemon: Daemon) =>
  daemon.bed.db.get<{ counter: number }>("SELECT counter FROM passkeys")?.counter;
export const passkeyCount = (daemon: Daemon) =>
  daemon.bed.db.get<{ c: number }>("SELECT count(*) AS c FROM passkeys")?.c;
export const fixed = (code: string) => ({ error: { code } });
