import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { sha256Hex } from "../../kernel/ids.ts";
import { createLogger } from "../../kernel/logger.ts";
import { createKnownDevices } from "./known-device.ts";
import { AUTH_MIGRATIONS } from "./index.ts";
import { dummyHash, verifyPassword } from "./passwords.ts";
import { createAuthService, RateLimitedError, type AuthService } from "./service.ts";
import { createSetupToken } from "./setup-token.ts";
import { createAuthStore } from "./store.ts";
import { sessionKey } from "./throttle-keys.ts";
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
    devices: createKnownDevices(randomBytes(32)),
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

const rowFor = (idHash: string, userId: string) => ({
  idHash,
  userId,
  createdAt: clock.now(),
  lastSeenAt: clock.now(),
  expiresAt: clock.now() + DAY,
  userAgent: null,
  ip: null,
  method: null,
  passkeyRef: null,
});

describe("auth service step-up and throttle", () => {
  describe("a table full of live lockouts", () => {
    it("keeps every lockout, refuses new keys without hashing, and leaves the session keys alone", async () => {
      const owner = await service.setup(setupInput(tokenOf(service.setupUrl())));
      const stolen = await service.startSession(
        createAuthStore(db).findUserByName("owner")?.id ?? "",
        undefined,
        { ip: "10.0.0.1", method: "password" },
      );
      for (let i = 0; i < 10; i++) throttle.fail(["user:owner"]);
      for (let i = 0; i < 10; i++) sessionThrottle.fail([sessionKey(stolen.cookieValue)]);
      for (let i = 0; i < 10_000 && throttle.size() < 10_000; i++) throttle.fail([`ip:2001:db8::${i}`]);
      expect(throttle.size()).toBe(10_000);
      vi.mocked(verifyPassword).mockClear();
      vi.mocked(dummyHash).mockClear();

      const attempt = (username: string, ip: string) => service.login(loginInput(PASSWORD, ip, username));
      const refused = await attempt("nobody", "10.9.9.9").catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(RateLimitedError);
      expect((refused as RateLimitedError).retryAfterMs).toBe(60_000);
      const locked = await attempt("owner", "10.9.9.8").catch((e: unknown) => e);
      expect((locked as RateLimitedError).retryAfterMs).toBe(60_000);
      expect(verifyPassword).not.toHaveBeenCalled();
      expect(throttle.size()).toBe(10_000);

      const stolenGuess = service
        .confirmSession({ cookieValue: stolen.cookieValue, password: PASSWORD, ip: "10.9.9.7" })
        .catch((e: unknown) => e);
      expect(((await stolenGuess) as RateLimitedError).retryAfterMs).toBe(60_000);
      await service.confirmSession({ cookieValue: owner.cookieValue, password: PASSWORD, ip: "10.9.9.6" });
      expect(service.authenticate(owner.cookieValue)?.stepUpUntil).toBe(clock.now() + 5 * 60_000);
    });

    it("still signs a known device in: its keys live in a table the spray cannot fill (RT-06)", async () => {
      const owner = await service.setup(setupInput(tokenOf(service.setupUrl())));
      const deviceCookie = owner.deviceCookie ?? "";
      expect(deviceCookie).not.toBe("");
      for (let i = 0; i < 10_000 && throttle.size() < 10_000; i++) throttle.fail([`ip:2001:db8::${i}`]);
      expect(throttle.size()).toBe(10_000);
      const sessionKeys = sessionThrottle.size();
      const bare = await service.login(loginInput(PASSWORD, "10.9.9.9")).catch((e: unknown) => e);
      expect(bare).toBeInstanceOf(RateLimitedError);
      const known = await service.login({ ...loginInput(PASSWORD, "10.9.9.9"), deviceCookie });
      expect(known.cookieValue).not.toBe("");
      expect(known.deviceCookie).toBeUndefined();
      // Its failures count in the table the spray did not touch, and the full table gains nothing.
      await expect(
        service.login({ ...loginInput("wrong password!!", "10.9.9.9"), deviceCookie }),
      ).rejects.toMatchObject({
        code: "unauthenticated",
      });
      expect(sessionThrottle.size()).toBe(sessionKeys + 1);
      expect(throttle.size()).toBe(10_000);
    });

    it("answers a setup after the owner exists without counting anything", async () => {
      await service.setup(setupInput(tokenOf(service.setupUrl())));
      for (let i = 0; i < 5; i++) {
        await expect(service.setup(setupInput("x", "owner2"))).rejects.toMatchObject({
          code: "unauthenticated",
        });
      }
      expect(throttle.size()).toBe(0);
    });
  });

  describe("auth_throttle_full", () => {
    it("is logged once per 10 s, without a key or an address", async () => {
      await service.setup(setupInput(tokenOf(service.setupUrl())));
      for (let i = 0; i < 10_000; i++) throttle.fail([`ip:2001:db8::${i}`]);
      lines.length = 0;
      const refuse = (username: string) =>
        service.login(loginInput(PASSWORD, "10.9.9.9", username)).catch(() => 0);
      await refuse("nobody");
      await refuse("nobody2");
      const logged = () =>
        lines
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .filter((e) => e.msg === "auth_throttle_full");
      expect(logged()).toHaveLength(1);
      expect(lines.join("")).not.toContain("10.9.9.9");
      expect(lines.join("")).not.toContain("nobody");
      await clock.advance(10_000);
      await refuse("nobody3");
      expect(logged()).toHaveLength(2);
    });
  });

  describe("confirmSession", () => {
    it("leaves a second session of the same owner unconfirmed", async () => {
      const first = await service.setup(setupInput(tokenOf(service.setupUrl())));
      const second = service.startSession(createAuthStore(db).findUserByName("owner")?.id ?? "", undefined, {
        ip: "10.0.0.1",
        method: "password",
      });
      await service.confirmSession({ cookieValue: first.cookieValue, password: PASSWORD, ip: "10.0.0.1" });
      expect(service.authenticate(first.cookieValue)?.stepUpUntil).toBe(clock.now() + 5 * 60_000);
      expect(service.authenticate(second.cookieValue)?.stepUpUntil).toBe(0);
    });

    it("forgets the mark at sign-out, even if the same session id came back", async () => {
      const session = await service.setup(setupInput(tokenOf(service.setupUrl())));
      await service.confirmSession({ cookieValue: session.cookieValue, password: PASSWORD, ip: "10.0.0.1" });
      expect(service.authenticate(session.cookieValue)?.stepUpUntil).toBe(clock.now() + 5 * 60_000);
      service.logout(session.cookieValue);
      const idHash = sha256Hex(session.cookieValue);
      const userId = createAuthStore(db).findUserByName("owner")?.id ?? "";
      createAuthStore(db).insertSession({ ...rowFor(idHash, userId), publicId: "a".repeat(32) });
      expect(service.authenticate(session.cookieValue)?.stepUpUntil).toBe(0);
    });

    it("forgets the mark of a revoked device and of the devices signed out, even if the same session id came back (M13a)", async () => {
      const first = await service.setup(setupInput(tokenOf(service.setupUrl())));
      const userId = createAuthStore(db).findUserByName("owner")?.id ?? "";
      const second = service.startSession(userId, undefined, { ip: "10.0.0.1", method: "password" });
      const third = service.startSession(userId, undefined, { ip: "10.0.0.1", method: "password" });
      for (const s of [first, second, third]) {
        await service.confirmSession({ cookieValue: s.cookieValue, password: PASSWORD, ip: "10.0.0.1" });
        await clock.advance(2000);
      }
      const publicId = (s: { cookieValue: string }) =>
        service.authenticate(s.cookieValue)?.credentialId ?? "";
      const [firstId, secondId] = [publicId(first), publicId(second)];
      expect(service.revokeDevice(userId, secondId)).toBe(true);
      expect(service.revokeDevice(userId, secondId)).toBe(false);
      expect(service.revokeOtherDevices(userId, firstId)).toBe(1);
      expect(service.authenticate(first.cookieValue)?.stepUpUntil).toBeGreaterThan(0);
      expect(service.authenticate(second.cookieValue)).toBeNull();
      expect(service.authenticate(third.cookieValue)).toBeNull();
      for (const [s, id] of [
        [second, "b"],
        [third, "c"],
      ] as const) {
        createAuthStore(db).insertSession({
          ...rowFor(sha256Hex(s.cookieValue), userId),
          publicId: id.repeat(32),
        });
        expect(service.authenticate(s.cookieValue)?.stepUpUntil).toBe(0);
      }
    });

    it("marks nothing for a session that signs out while the password is being hashed", async () => {
      const session = await service.setup(setupInput(tokenOf(service.setupUrl())));
      audit.append.mockClear();
      const actual = await vi.importActual<typeof import("./passwords.ts")>("./passwords.ts");
      vi.mocked(verifyPassword).mockImplementationOnce(async (password, stored) => {
        service.logout(session.cookieValue);
        return actual.verifyPassword(password, stored);
      });
      const confirmation = service.confirmSession({
        cookieValue: session.cookieValue,
        password: PASSWORD,
        ip: "10.0.0.1",
      });
      await expect(confirmation).rejects.toMatchObject({ code: "unauthenticated" });
      expect(audit.append).not.toHaveBeenCalled();
    });
  });
});
