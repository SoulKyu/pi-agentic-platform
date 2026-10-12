import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { sha256Hex } from "../../kernel/ids.ts";
import { createLogger } from "../../kernel/logger.ts";
import { AUTH_MIGRATIONS } from "./index.ts";
import { dummyHash, verifyPassword } from "./passwords.ts";
import { createAuthService, RateLimitedError, type AuthService } from "./service.ts";
import { createSetupToken } from "./setup-token.ts";
import { createAuthStore } from "./store.ts";
import { createThrottle, type Throttle } from "./throttle.ts";

// Both calls go through to the real implementation; the spies only record who verifies what.
vi.mock("./passwords.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./passwords.ts")>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword), dummyHash: vi.fn(actual.dummyHash) };
});

const DAY = 24 * 3600 * 1000;
let lines: string[];
let dir: string;
let db: Db;
let clock: FakeClock;
let service: AuthService;
let throttle: Throttle;
let sessionThrottle: Throttle;
const audit = { append: vi.fn() };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-auth-"));
  clock = createFakeClock();
  lines = [];
  audit.append.mockClear();
  const logger = createLogger({ level: "debug", clock, write: (line) => lines.push(line) });
  db = migrate({
    dbPath: join(dir, "s.db"),
    backupsDir: join(dir, "b"),
    sources: [KERNEL_MIGRATIONS, AUTH_MIGRATIONS],
    clock,
    logger,
  }).db;
  lines.length = 0;
  throttle = createThrottle(clock, { whenFull: "refuse" });
  sessionThrottle = createThrottle(clock, { whenFull: "refuse" });
  service = createAuthService({
    store: createAuthStore(db),
    clock,
    logger,
    publicOrigin: "http://localhost:7777",
    throttle,
    sessionThrottle,
    setupToken: createSetupToken(true),
    audit,
  });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const tokenOf = (url: string | null) => new URL(url ?? "http://x").hash.replace("#token=", "");
const PASSWORD = "correct horse battery staple";
const setupInput = (token: string, username = "owner") => ({
  token,
  username,
  password: PASSWORD,
  ip: "127.0.0.1",
  userAgent: "test",
});
const loginInput = (password: string, ip = "10.0.0.1", username = "owner") => ({
  username,
  password,
  ip,
  userAgent: undefined,
});
const events = (name: string): Record<string, unknown>[] =>
  lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.msg === name);
const count = (table: string) => db.get<{ c: number }>(`SELECT count(*) AS c FROM ${table}`)?.c;

describe("auth service", () => {
  it("publishes a one-time setup URL with the token in the fragment", async () => {
    const url = service.setupUrl();
    expect(url?.startsWith("http://localhost:7777/setup#token=")).toBe(true);
    await service.setup(setupInput(tokenOf(url)));
    expect(service.setupUrl()).toBeNull();
    expect(service.status(undefined).setupRequired).toBe(false);
  });

  it("refuses a wrong setup token and any second setup", async () => {
    await expect(service.setup(setupInput("wrong"))).rejects.toThrow(PapError);
    const token = tokenOf(service.setupUrl());
    await clock.advance(2000);
    await service.setup(setupInput(token));
    await clock.advance(2000);
    await expect(service.setup(setupInput(token, "second"))).rejects.toThrow(PapError);
  });

  it("creates exactly one owner when two setups race", async () => {
    const token = tokenOf(service.setupUrl());
    const results = await Promise.allSettled([
      service.setup(setupInput(token, "one")),
      service.setup(setupInput(token, "two")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected");
    expect(loser?.reason).toBeInstanceOf(PapError);
    expect((loser?.reason as PapError).code).toBe("conflict");
    expect(count("users")).toBe(1);
  });

  it("refuses a password under 12 characters with a fixed error and leaves the token usable", async () => {
    const token = tokenOf(service.setupUrl());
    const short = "only-11-chr";
    const failure = await service.setup({ ...setupInput(token), password: short }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PapError);
    expect((failure as PapError).code).toBe("bad_request");
    expect((failure as PapError).message).not.toContain(short);
    expect(count("users")).toBe(0);
    expect(service.setupUrl()).not.toBeNull();
    await service.setup(setupInput(token));
    expect(count("users")).toBe(1);
  });

  it("stores only hashes: a scrypt password hash and the session id's digest", async () => {
    const session = await service.setup(setupInput(tokenOf(service.setupUrl())));
    const user = db.get<{ password_hash: string }>("SELECT password_hash FROM users");
    expect(user?.password_hash.startsWith("scrypt$")).toBe(true);
    expect(user?.password_hash).not.toContain(PASSWORD);
    const row = db.get<{ id_hash: string }>("SELECT id_hash FROM auth_sessions");
    expect(row?.id_hash).toBe(sha256Hex(session.cookieValue));
    expect(row?.id_hash).not.toBe(session.cookieValue);
    expect(session.cookieValue.length).toBeGreaterThanOrEqual(43);
  });

  it("logs in with the right password, rejects a wrong one, then throttles", async () => {
    await service.setup(setupInput(tokenOf(service.setupUrl())));
    const session = await service.login(loginInput(PASSWORD, "10.0.0.1", "OWNER"));
    expect(service.authenticate(session.cookieValue)?.username).toBe("owner");
    await expect(service.login(loginInput("nope-nope-nope"))).rejects.toThrow(PapError);
    await expect(service.login(loginInput(PASSWORD))).rejects.toThrow(RateLimitedError);
  });

  it("answers an unknown account exactly like a wrong password", async () => {
    await service.setup(setupInput(tokenOf(service.setupUrl())));
    const unknown = await service.login(loginInput(PASSWORD, "10.0.0.2", "ghost")).catch((e: unknown) => e);
    const wrong = await service.login(loginInput("nope-nope-nope", "10.0.0.3")).catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(PapError);
    expect(wrong).toBeInstanceOf(PapError);
    expect([(unknown as PapError).code, (unknown as PapError).message]).toEqual([
      (wrong as PapError).code,
      (wrong as PapError).message,
    ]);
  });

  it("verifies an unknown account against the dummy hash, and a known one against its own", async () => {
    await service.setup(setupInput(tokenOf(service.setupUrl())));
    const stored = db.get<{ password_hash: string }>("SELECT password_hash FROM users")?.password_hash;
    vi.mocked(verifyPassword).mockClear();
    await expect(service.login(loginInput("some-guess-123", "10.0.0.2", "ghost"))).rejects.toMatchObject({
      code: "unauthenticated",
    });
    expect(verifyPassword).toHaveBeenCalledTimes(1);
    expect(verifyPassword).toHaveBeenLastCalledWith("some-guess-123", await dummyHash());
    expect(await dummyHash()).not.toBe(stored);
    await service.login(loginInput(PASSWORD, "10.0.0.3"));
    expect(verifyPassword).toHaveBeenCalledTimes(2);
    expect(verifyPassword).toHaveBeenLastCalledWith(PASSWORD, stored);
  });

  it("still answers unauthenticated for an unknown account when the dummy hash cannot be computed", async () => {
    await service.setup(setupInput(tokenOf(service.setupUrl())));
    vi.mocked(dummyHash).mockRejectedValueOnce(new Error("scrypt failed"));
    const failure = await service.login(loginInput(PASSWORD, "10.0.0.2", "ghost")).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PapError);
    expect((failure as PapError).code).toBe("unauthenticated");
  });

  it("lets only one of several parallel guesses reach the password check", async () => {
    await service.setup(setupInput(tokenOf(service.setupUrl())));
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => service.login(loginInput(`wrong-password-${i}`, "9.9.9.9"))),
    );
    const reasons = attempts.map((a) => (a.status === "rejected" ? (a.reason as unknown) : null));
    expect(reasons.filter((r) => r instanceof RateLimitedError)).toHaveLength(5);
    expect(reasons.filter((r) => r instanceof PapError && !(r instanceof RateLimitedError))).toHaveLength(1);
  });

  it("throttles a repeated account across addresses, and an address across accounts", async () => {
    await service.setup(setupInput(tokenOf(service.setupUrl())));
    await expect(service.login(loginInput("nope-nope-nope", "1.1.1.1"))).rejects.toMatchObject({
      code: "unauthenticated",
    });
    await expect(service.login(loginInput(PASSWORD, "2.2.2.2"))).rejects.toBeInstanceOf(RateLimitedError);
    await expect(service.login(loginInput(PASSWORD, "1.1.1.1", "ghost"))).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    await clock.advance(1000);
    await service.login(loginInput(PASSWORD, "2.2.2.2"));
  });

  it("slides a session forward and drops it after expiry or logout", async () => {
    const session = await service.setup(setupInput(tokenOf(service.setupUrl())));
    await clock.advance(2 * DAY);
    expect(service.authenticate(session.cookieValue)).not.toBeNull();
    await clock.advance(29 * DAY);
    expect(service.authenticate(session.cookieValue)).not.toBeNull();
    service.logout(session.cookieValue);
    expect(service.authenticate(session.cookieValue)).toBeNull();
    const other = await service.login(loginInput(PASSWORD, "1.1.1.1"));
    await clock.advance(31 * DAY);
    expect(service.authenticate(other.cookieValue)).toBeNull();
  });

  it("does not extend a session that was just extended, and prunes expired ones at the next sign-in", async () => {
    const first = await service.setup(setupInput(tokenOf(service.setupUrl())));
    const expiry = () => db.get<{ e: number }>("SELECT expires_at AS e FROM auth_sessions")?.e;
    const initial = expiry();
    await clock.advance(DAY / 2);
    service.authenticate(first.cookieValue);
    expect(expiry()).toBe(initial);
    await clock.advance(31 * DAY);
    expect(service.authenticate(first.cookieValue)).toBeNull();
    await service.login(loginInput(PASSWORD, "1.1.1.1"));
    expect(count("auth_sessions")).toBe(1);
  });

  it("checks a session without sliding it when asked: a keepalive tick must not keep it alive (R130)", async () => {
    const session = await service.setup(setupInput(tokenOf(service.setupUrl())));
    const expiry = () => db.get<{ e: number }>("SELECT expires_at AS e FROM auth_sessions")?.e;
    const initial = expiry();
    await clock.advance(2 * DAY);
    expect(service.authenticate(session.cookieValue, { slide: false })?.username).toBe("owner");
    expect(expiry()).toBe(initial);
    expect(service.authenticate(session.cookieValue)?.username).toBe("owner");
    expect(expiry()).toBeGreaterThan(initial ?? 0);
    const other = await service.login(loginInput(PASSWORD, "1.1.1.1"));
    await clock.advance(31 * DAY);
    expect(service.authenticate(other.cookieValue, { slide: false })).toBeNull();
  });

  describe("on a database that cannot be written (R130)", () => {
    const serviceOver = (extendSession: () => void) =>
      createAuthService({
        store: { ...createAuthStore(db), extendSession },
        clock,
        logger: createLogger({ level: "debug", clock, write: () => {} }),
        publicOrigin: "http://localhost:7777",
        throttle,
        sessionThrottle,
        setupToken: createSetupToken(false),
        audit,
      });

    it("still knows the caller when only the slide fails, and does not slide", async () => {
      const session = await service.setup(setupInput(tokenOf(service.setupUrl())));
      const readOnly = serviceOver(() => {
        throw new Error("attempt to write a readonly database");
      });
      await clock.advance(2 * DAY);
      expect(readOnly.authenticate(session.cookieValue)?.username).toBe("owner");
      expect(readOnly.status(session.cookieValue)).toMatchObject({ authenticated: true });
    });

    it("lets any other failure of the slide through", async () => {
      const session = await service.setup(setupInput(tokenOf(service.setupUrl())));
      const broken = serviceOver(() => {
        throw new Error("disk I/O error");
      });
      await clock.advance(2 * DAY);
      expect(() => broken.authenticate(session.cookieValue)).toThrow("disk I/O error");
    });
  });

  it("ignores empty, oversized and unknown session values", async () => {
    await service.setup(setupInput(tokenOf(service.setupUrl())));
    expect(service.authenticate(undefined)).toBeNull();
    expect(service.authenticate("")).toBeNull();
    expect(service.authenticate("x".repeat(500))).toBeNull();
    expect(service.authenticate("not-a-session")).toBeNull();
    service.logout(undefined);
    expect(count("auth_sessions")).toBe(1);
  });

  describe("security log", () => {
    const keysOf = (entry: Record<string, unknown> | undefined) => Object.keys(entry ?? {}).sort();

    it("records a failed sign-in with the address and the delay in force, nothing else", async () => {
      await service.setup(setupInput(tokenOf(service.setupUrl())));
      await clock.advance(2000);
      lines.length = 0;
      await service.login(loginInput("guess-one-123", "10.0.0.1", "ghost")).catch(() => undefined);
      await clock.advance(1000);
      await service.login(loginInput("guess-two-123", "10.0.0.1", "owner")).catch(() => undefined);
      const failed = events("auth_login_failed");
      expect(failed.map((entry) => [entry.ip, entry.retryAfterMs])).toEqual([
        ["10.0.0.1", 1000],
        ["10.0.0.1", 2000],
      ]);
      expect(keysOf(failed[0])).toEqual(["ip", "level", "msg", "retryAfterMs", "time"]);
      expect(failed[0]?.level).toBe("warn");
    });

    it("records a failed setup, and a throttled attempt at most once every ten seconds per address", async () => {
      await service.setup({ ...setupInput("wrong-token-value"), ip: "10.0.0.5" }).catch(() => undefined);
      expect(events("auth_setup_failed").map((entry) => [entry.ip, entry.retryAfterMs])).toEqual([
        ["10.0.0.5", 1000],
      ]);
      const bad = (password: string) =>
        service.login(loginInput(password, "10.0.0.1", "ghost")).catch((e: unknown) => e);
      await bad("guess-one-123");
      expect(await bad("guess-two-123")).toBeInstanceOf(RateLimitedError);
      expect(await bad("guess-two-123")).toBeInstanceOf(RateLimitedError);
      expect(events("auth_throttled")).toHaveLength(1);
      expect(keysOf(events("auth_throttled")[0])).toEqual(["ip", "level", "msg", "retryAfterMs", "time"]);
      expect(events("auth_throttled")[0]).toMatchObject({ ip: "10.0.0.1", retryAfterMs: 1000 });
      await clock.advance(10_000);
      await bad("guess-three-123");
      expect(await bad("guess-four-123")).toBeInstanceOf(RateLimitedError);
      expect(events("auth_throttled")).toHaveLength(2);
    });

    it("never writes a username, a password or a token, on any path", async () => {
      const url = service.setupUrl();
      const secrets = ["ada.lovelace", "ghost.typed-a-password", PASSWORD, "guess-one-123", tokenOf(url)];
      const setupAs = { ...setupInput("wrong-token-value", "ada.lovelace"), ip: "10.0.0.5" };
      await service.setup(setupAs).catch(() => undefined);
      await clock.advance(2000);
      await service.setup({ ...setupAs, token: tokenOf(url) });
      await service
        .login(loginInput("guess-one-123", "10.0.0.1", "ghost.typed-a-password"))
        .catch(() => undefined);
      await service
        .login(loginInput("guess-one-123", "10.0.0.1", "ghost.typed-a-password"))
        .catch(() => undefined);
      await service.login(loginInput(PASSWORD, "10.0.0.7", "ada.lovelace")).catch(() => undefined);
      expect(lines.length).toBeGreaterThan(3);
      for (const secret of secrets) expect(lines.join(""), secret).not.toContain(secret);
    });
  });
});
