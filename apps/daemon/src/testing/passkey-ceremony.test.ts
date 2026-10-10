import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "../kernel/clock.ts";
import type { Db } from "../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../kernel/db/migrate.ts";
import { createHttpApp } from "../kernel/http/app.ts";
import { createLogger } from "../kernel/logger.ts";
import { AUTH_MIGRATIONS, createAuthModule, type AuthModule } from "../modules/auth/index.ts";
import {
  createSoftwareAuthenticator,
  type CeremonyOverrides,
  type SoftwareAuthenticator,
} from "./software-authenticator.ts";

// Real @simplewebauthn/server verification behind the real routes; only the authenticator is simulated.
const LOCAL = "http://localhost:7777";
const SECURE = "https://pap.example.net";
const PASSWORD = "correct horse battery staple";

let dir: string;
let db: Db;
let clock: FakeClock;
let lines: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-ceremony-"));
  clock = createFakeClock();
  lines = [];
  db = migrate({
    dbPath: join(dir, "s.db"),
    backupsDir: join(dir, "b"),
    sources: [KERNEL_MIGRATIONS, AUTH_MIGRATIONS],
    clock,
    logger: createLogger({ level: "error", clock, write: () => undefined }),
  }).db;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Daemon {
  readonly app: Hono;
  readonly auth: AuthModule;
  readonly origin: string;
  readonly authenticator: SoftwareAuthenticator;
}
function start(origin = LOCAL): Daemon {
  const logger = createLogger({ level: "debug", clock, write: (line) => lines.push(line) });
  const allowedOrigins = new Set([origin]);
  const auth = createAuthModule({ db, clock, logger, publicOrigin: origin, allowedOrigins });
  const app = createHttpApp({
    allowedOrigins,
    staticRoot: null,
    logger,
    mount: (a) => auth.mount(a),
    wsProbe: (c) => c.json({}),
  });
  const authenticator = createSoftwareAuthenticator({ origin, rpId: new URL(origin).hostname });
  return { app, auth, origin, authenticator };
}

async function call(daemon: Daemon, path: string, body?: unknown, cookie?: string) {
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
const cookieOf = (setCookie: string) => setCookie.split(";")[0] ?? "";

async function ownerCookie(daemon: Daemon): Promise<string> {
  const token = new URL(daemon.auth.setupUrl() ?? "http://x").hash.replace("#token=", "");
  const setup = await call(daemon, "/auth/setup", { token, username: "owner", password: PASSWORD });
  expect(setup.status).toBe(201);
  return cookieOf(setup.setCookie);
}

async function begin(daemon: Daemon, kind: "register" | "login", cookie?: string) {
  const { body } = await call(daemon, `/auth/passkey/${kind}/options`, undefined, cookie);
  const { flowId, options } = body as { flowId: string; options: { challenge: string } };
  return { flowId, challenge: options.challenge };
}

async function enroll(daemon: Daemon, cookie: string, overrides?: CeremonyOverrides) {
  const { flowId, challenge } = await begin(daemon, "register", cookie);
  const response = daemon.authenticator.create(challenge, overrides);
  return call(daemon, "/auth/passkey/register/verify", { flowId, response }, cookie);
}

// Waits out the throttle a previous failure may have set, so each call tests its own refusal.
async function signIn(daemon: Daemon, overrides?: CeremonyOverrides, cookie?: string) {
  await clock.advance(61_000);
  const { flowId, challenge } = await begin(daemon, "login");
  const response = daemon.authenticator.get(challenge, overrides);
  return {
    ...(await call(daemon, "/auth/passkey/login/verify", { flowId, response }, cookie)),
    flowId,
    response,
  };
}

const counter = () => db.get<{ counter: number }>("SELECT counter FROM passkeys")?.counter;
const rows = () => db.get<{ c: number }>("SELECT count(*) AS c FROM passkeys")?.c;
const fixed = (code: string) => ({ error: { code } });

describe("passkey ceremonies against the real verifier", () => {
  it("enrolls while signed in, then signs in with the passkey alone on a brand-new session", async () => {
    const daemon = start();
    const first = await ownerCookie(daemon);
    expect((await enroll(daemon, first)).status).toBe(200);
    expect(db.get("SELECT * FROM passkeys")).toMatchObject({ user_id: expect.any(String), counter: 0 });
    await call(daemon, "/auth/logout", {}, first);
    expect(daemon.auth.authenticateCookieHeader(first)).toBeNull();

    const planted = "pap_session=planted-by-an-attacker";
    const result = await signIn(daemon, undefined, planted);
    expect(result.status).toBe(200);
    const session = cookieOf(result.setCookie);
    expect(session).toMatch(/^pap_session=[\w-]{43,}$/);
    expect([session, first]).not.toContain(planted);
    expect(session).not.toBe(first);
    for (const attribute of ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=2592000"]) {
      expect(result.setCookie).toContain(attribute);
    }
    expect(result.setCookie).not.toContain("Secure");
    const status = await daemon.app.request(new URL("/auth/status", daemon.origin).href, {
      headers: { cookie: session },
    });
    expect(await status.json()).toMatchObject({ authenticated: true, username: "owner" });
    expect(daemon.auth.authenticateCookieHeader(planted)).toBeNull();
    expect(counter()).toBe(1);
  });

  it("sets Secure on the sign-in cookie when the public origin is https", async () => {
    const daemon = start(SECURE);
    expect((await enroll(daemon, await ownerCookie(daemon))).status).toBe(200);
    const result = await signIn(daemon);
    expect(result.status).toBe(200);
    expect(result.setCookie).toContain("Secure");
    expect(result.setCookie).toContain("HttpOnly");
  });

  it("registers nothing for a caller without a session, and nothing for an unknown flow", async () => {
    const daemon = start();
    const cookie = await ownerCookie(daemon);
    const { flowId, challenge } = await begin(daemon, "register", cookie);
    const response = daemon.authenticator.create(challenge);
    const anonymous = await call(daemon, "/auth/passkey/register/verify", { flowId, response });
    expect([anonymous.status, anonymous.body]).toEqual([401, fixed("unauthenticated")]);
    const forged = await call(
      daemon,
      "/auth/passkey/register/verify",
      { flowId, response },
      "pap_session=forged",
    );
    expect(forged.status).toBe(401);
    expect(rows()).toBe(0);
    // The flow was never consumed by those, but is bound to the signed-in user and works once.
    expect((await call(daemon, "/auth/passkey/register/verify", { flowId, response }, cookie)).status).toBe(
      200,
    );
    expect((await call(daemon, "/auth/passkey/register/verify", { flowId, response }, cookie)).status).toBe(
      401,
    );
    expect(rows()).toBe(1);
  });

  it("refuses to enroll an authenticator that did not verify the user", async () => {
    const daemon = start();
    const cookie = await ownerCookie(daemon);
    const failed = await enroll(daemon, cookie, { userVerified: false });
    expect([failed.status, failed.body]).toEqual([401, fixed("unauthenticated")]);
    expect(rows()).toBe(0);
    expect(lines.filter((line) => line.includes("auth_passkey_failed"))).toHaveLength(1);
  });

  it("refuses a sign-in whose assertion lacks user verification, even with a valid signature", async () => {
    const daemon = start();
    expect((await enroll(daemon, await ownerCookie(daemon))).status).toBe(200);
    const result = await signIn(daemon, { userVerified: false });
    expect([result.status, result.body, result.setCookie]).toEqual([401, fixed("unauthenticated"), ""]);
    expect(counter()).toBe(0);
  });

  it("stores the counter and rejects an assertion that does not advance it", async () => {
    const daemon = start();
    expect((await enroll(daemon, await ownerCookie(daemon))).status).toBe(200);
    expect((await signIn(daemon)).status).toBe(200);
    expect((await signIn(daemon)).status).toBe(200);
    expect(counter()).toBe(2);
    for (const stale of [2, 1]) {
      const replay = await signIn(daemon, { counter: stale });
      expect([replay.status, replay.setCookie], `counter ${stale}`).toEqual([401, ""]);
      expect(counter()).toBe(2);
    }
    expect((await signIn(daemon, { counter: 9 })).status).toBe(200);
    expect(counter()).toBe(9);
  });

  it("accepts an authenticator that never counts (synced passkeys report 0)", async () => {
    const daemon = start();
    expect((await enroll(daemon, await ownerCookie(daemon))).status).toBe(200);
    expect((await signIn(daemon, { counter: 0 })).status).toBe(200);
    expect((await signIn(daemon, { counter: 0 })).status).toBe(200);
    expect(counter()).toBe(0);
  });

  it("refuses a credential id that is already registered", async () => {
    const daemon = start();
    const cookie = await ownerCookie(daemon);
    expect((await enroll(daemon, cookie)).status).toBe(200);
    const again = await enroll(daemon, cookie);
    expect([again.status, again.body]).toEqual([409, fixed("conflict")]);
    expect(rows()).toBe(1);
  });

  it("refuses a wrong origin, a wrong RP ID, a foreign challenge and a corrupted signature", async () => {
    const daemon = start();
    expect((await enroll(daemon, await ownerCookie(daemon))).status).toBe(200);
    for (const overrides of [{ origin: "http://evil.example" }, { rpId: "evil.example" }]) {
      const result = await signIn(daemon, overrides);
      expect([result.status, result.setCookie], JSON.stringify(overrides)).toEqual([401, ""]);
    }
    await clock.advance(61_000);
    const [mine, other] = [await begin(daemon, "login"), await begin(daemon, "login")];
    const foreign = daemon.authenticator.get(other.challenge);
    expect(
      (await call(daemon, "/auth/passkey/login/verify", { flowId: mine.flowId, response: foreign })).status,
    ).toBe(401);

    await clock.advance(61_000);
    const signed = await begin(daemon, "login");
    const response = daemon.authenticator.get(signed.challenge) as { response: { signature: string } };
    const bytes = Buffer.from(response.response.signature, "base64url");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    response.response.signature = bytes.toString("base64url");
    const corrupted = await call(daemon, "/auth/passkey/login/verify", { flowId: signed.flowId, response });
    expect(corrupted.status).toBe(401);
    expect(counter()).toBe(0);
  });

  it("uses an assertion once: replaying it, or a flow that already failed, is refused", async () => {
    const daemon = start();
    expect((await enroll(daemon, await ownerCookie(daemon))).status).toBe(200);
    const first = await signIn(daemon);
    expect(first.status).toBe(200);
    await clock.advance(61_000);
    const replay = await call(daemon, "/auth/passkey/login/verify", {
      flowId: first.flowId,
      response: first.response,
    });
    expect([replay.status, replay.setCookie]).toEqual([401, ""]);

    const failing = await signIn(daemon, { rpId: "evil.example" });
    expect(failing.status).toBe(401);
    await clock.advance(61_000);
    const retry = await call(daemon, "/auth/passkey/login/verify", {
      flowId: failing.flowId,
      response: failing.response,
    });
    expect(retry.status).toBe(401);
    expect(counter()).toBe(1);
  });

  it("backs off on repeated failures from one address and forgets them after a successful sign-in", async () => {
    const daemon = start();
    expect((await enroll(daemon, await ownerCookie(daemon))).status).toBe(200);
    const evil = { origin: "http://evil.example" };
    expect((await signIn(daemon, evil)).status).toBe(401);
    expect((await signIn(daemon, evil)).status).toBe(401);
    expect((await signIn(daemon)).status).toBe(200);
    expect((await signIn(daemon, evil)).status).toBe(401);
    const delays = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.msg === "auth_passkey_failed")
      .map((entry) => entry.retryAfterMs);
    expect(delays).toEqual([1000, 2000, 1000]);
  });

  it("refuses an authenticator that was never enrolled", async () => {
    const daemon = start();
    expect((await enroll(daemon, await ownerCookie(daemon))).status).toBe(200);
    const stranger = createSoftwareAuthenticator({ origin: LOCAL, rpId: "localhost" });
    await clock.advance(61_000);
    const { flowId, challenge } = await begin(daemon, "login");
    const result = await call(daemon, "/auth/passkey/login/verify", {
      flowId,
      response: stranger.get(challenge),
    });
    expect([result.status, result.setCookie]).toEqual([401, ""]);
  });
});
