import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { PapError, permissionsOf } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../kernel/ids.ts";
import { createClientPathGate } from "../../kernel/ws/client-path-gate.ts";
import { hashPassword } from "./passwords.ts";
import { DAY, createTokenBed } from "./testing/token-bed.ts";
import { call, cookieOf, enroll, ownerCookie, signIn, startDaemon, type Daemon } from "./testing/ceremony.ts";
import { createAuthTestBed, PASSWORD, type AuthTestBed } from "./testing/fixture.ts";
import { insertUserRow } from "./testing/users.ts";

let bed: AuthTestBed;
beforeEach(() => {
  bed = createAuthTestBed();
});
afterEach(() => bed.dispose());

async function withMember(): Promise<{ daemon: Daemon; memberId: string }> {
  const daemon = startDaemon(bed);
  await ownerCookie(daemon);
  const memberId = "member-1";
  const created = daemon.auth.insertMember({
    id: memberId,
    username: "mia",
    passwordHash: await hashPassword(PASSWORD),
    createdAt: bed.clock.now(),
  });
  expect(created).toBe(true);
  return { daemon, memberId };
}
const memberLogin = (daemon: Daemon, password = PASSWORD) =>
  call(daemon, "/auth/login", { username: "mia", password });
const sessionCount = (userId: string) =>
  bed.db.get<{ c: number }>("SELECT count(*) AS c FROM auth_sessions WHERE user_id = $userId", { userId })?.c;

describe("roles", () => {
  it("the oldest user becomes the owner and a second owner is refused by the index", () => {
    const old = bed.db;
    const sql = (name: string) => readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8");
    old.exec("DROP INDEX users_one_owner");
    old.exec("ALTER TABLE users DROP COLUMN role");
    old.exec("ALTER TABLE users DROP COLUMN disabled_at");
    old.exec("ALTER TABLE users DROP COLUMN last_seen_at");
    old.exec("ALTER TABLE users DROP COLUMN budget_usd");
    for (const [id, createdAt] of [
      ["u-b", 5],
      ["u-new", 9],
      ["u-a", 2],
      ["u-old", 2],
    ] as const)
      old.run(
        "INSERT INTO users (id, username, password_hash, created_at) VALUES ($id, $id, 'x', $createdAt)",
        {
          id,
          createdAt,
        },
      );
    old.exec(sql("202610241300_user_roles.sql"));
    expect(old.all("SELECT id FROM users WHERE role = 'owner'")).toEqual([{ id: "u-a" }]);
    expect(() => insertUserRow(old, { id: "second", role: "owner" })).toThrow();
  });

  it("an unknown or deleted id counts as disabled and as a member (fail closed)", async () => {
    const { daemon, memberId } = await withMember();
    expect(daemon.auth.isDisabled(memberId)).toBe(false);
    expect(daemon.auth.isDisabled("no-such-user")).toBe(true);
    expect(daemon.auth.isMember("no-such-user")).toBe(true);
  });

  it("a member's cookie session lacks pi:read and users:read", async () => {
    const { daemon } = await withMember();
    const login = await memberLogin(daemon);
    expect(login.status).toBe(200);
    const caller = daemon.auth.authenticateCredential({
      kind: "cookie",
      value: cookieOf(login.setCookie).split("=")[1] ?? "",
    });
    expect(caller?.permissions.has("sessions:read")).toBe(true);
    expect(caller?.permissions.has("pi:read")).toBe(false);
    expect(caller?.permissions.has("users:read")).toBe(false);
    expect(caller?.permissions).toEqual(permissionsOf("member"));
  });

  it("a disabled user's session and token stop authenticating at once", async () => {
    const { daemon, memberId } = await withMember();
    const login = await memberLogin(daemon);
    const cookie: { kind: "cookie"; value: string } = {
      kind: "cookie",
      value: cookieOf(login.setCookie).split("=")[1] ?? "",
    };
    const value = `pap_${randomBytes(32).toString("base64url")}`;
    bed.db.run(
      "INSERT INTO api_tokens (id, user_id, name, hint, secret_hash, permissions, created_at, expires_at) VALUES ('t1', $userId, 't', 'abcd', $hash, '[\"sessions:read\"]', 0, $exp)",
      { userId: memberId, hash: sha256Hex(value), exp: bed.clock.now() + DAY },
    );
    const bearer: { kind: "bearer"; value: string } = { kind: "bearer", value };
    expect(daemon.auth.authenticateCredential(cookie)).not.toBeNull();
    expect(daemon.auth.authenticateCredential(bearer)).not.toBeNull();
    daemon.auth.setDisabled(memberId, true);
    expect(daemon.auth.authenticateCredential(cookie)).toBeNull();
    expect(daemon.auth.authenticateCredential(bearer)).toBeNull();
    // Disabling signs the user out for good: enabling again resurrects neither the session nor the token.
    daemon.auth.setDisabled(memberId, false);
    expect(daemon.auth.authenticateCredential(cookie)).toBeNull();
    expect(daemon.auth.authenticateCredential(bearer)).toBeNull();
  });

  it("the session and token checks of a disabled user hold without any revoke", async () => {
    const { daemon, memberId } = await withMember();
    const cookie = "c".repeat(43);
    bed.db.run(
      "INSERT INTO auth_sessions (id_hash, user_id, created_at, last_seen_at, expires_at, public_id) VALUES ($h, $userId, 0, 0, $exp, 'pub-1')",
      { h: sha256Hex(cookie), userId: memberId, exp: bed.clock.now() + DAY },
    );
    const value = `pap_${randomBytes(32).toString("base64url")}`;
    bed.db.run(
      "INSERT INTO api_tokens (id, user_id, name, hint, secret_hash, permissions, created_at, expires_at) VALUES ('t1', $userId, 't', 'abcd', $hash, '[\"sessions:read\"]', 0, $exp)",
      { userId: memberId, hash: sha256Hex(value), exp: bed.clock.now() + DAY },
    );
    const asCookie = { kind: "cookie" as const, value: cookie };
    const asBearer = { kind: "bearer" as const, value };
    expect(daemon.auth.authenticateCredential(asCookie)).not.toBeNull();
    expect(daemon.auth.authenticateCredential(asBearer)).not.toBeNull();
    bed.db.run("UPDATE users SET disabled_at = 1 WHERE id = $memberId", { memberId });
    expect(daemon.auth.authenticateCredential(asCookie)).toBeNull();
    expect(daemon.auth.authenticateCredential(asBearer)).toBeNull();
  });

  it("disabling rolls the whole change back when a delete fails, so Enable cannot revive credentials", async () => {
    const { daemon, memberId } = await withMember();
    const login = await memberLogin(daemon);
    expect(login.status).toBe(200);
    bed.db.exec(
      "CREATE TRIGGER fail_token_delete BEFORE DELETE ON api_tokens BEGIN SELECT RAISE(ABORT, 'busy'); END",
    );
    bed.db.run(
      "INSERT INTO api_tokens (id, user_id, name, hint, secret_hash, permissions, created_at, expires_at) VALUES ('t1', $memberId, 't', 'abcd', '" +
        "h".repeat(64) +
        "', '[]', 0, $exp)",
      { memberId, exp: bed.clock.now() + DAY },
    );
    expect(() => daemon.auth.setDisabled(memberId, true)).toThrow();
    expect(daemon.auth.users().find((u) => u.id === memberId)?.disabledAt).toBeNull();
    expect(sessionCount(memberId)).toBe(1);
  });

  it("the host gate fails closed: only the owner is not gated, an unknown or deleted id is", async () => {
    const { daemon, memberId } = await withMember();
    const ownerId = daemon.auth.ownerId() ?? "";
    expect(daemon.auth.isMember(ownerId)).toBe(false);
    expect(daemon.auth.isMember(memberId)).toBe(true);
    expect(daemon.auth.isMember("nobody")).toBe(true);
    const gate = createClientPathGate({ isMember: daemon.auth.isMember, boxes: () => undefined });
    expect(gate.allows("nobody", ["/home/ubuntu"])).toBe(false);
    expect(gate.allows(ownerId, ["/home/ubuntu"])).toBe(true);
    daemon.auth.deleteUser(memberId);
    expect(gate.allows(memberId, ["/home/ubuntu"])).toBe(false);
  });

  it("refuses to disable or delete the owner", async () => {
    const { daemon } = await withMember();
    const ownerId = daemon.auth.ownerId() ?? "";
    expect(() => daemon.auth.setDisabled(ownerId, true)).toThrow(new PapError("forbidden"));
    expect(() => daemon.auth.deleteUser(ownerId)).toThrow(new PapError("forbidden"));
    expect(daemon.auth.roleOf(ownerId)).toBe("owner");
    expect(daemon.auth.isMember(ownerId)).toBe(false);
  });

  it("a correct password on a disabled account answers account_disabled", async () => {
    const { daemon, memberId } = await withMember();
    daemon.auth.setDisabled(memberId, true);
    const wrong = await memberLogin(daemon, "wrong wrong wrong");
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual({ error: { code: "unauthenticated" } });
    await bed.clock.advance(61_000);
    const right = await memberLogin(daemon);
    expect(right.status).toBe(403);
    expect(right.body).toEqual({ error: { code: "account_disabled" } });
    expect(right.setCookie).toBe("");
    expect(sessionCount(memberId)).toBe(0);
  });

  it("a passkey login on a disabled account answers account_disabled and mints no session", async () => {
    const { daemon, memberId } = await withMember();
    const login = await memberLogin(daemon);
    expect((await enroll(daemon, cookieOf(login.setCookie))).status).toBe(200);
    daemon.auth.setDisabled(memberId, true);
    const attempt = await signIn(daemon);
    expect(attempt.status).toBe(403);
    expect(attempt.body).toEqual({ error: { code: "account_disabled" } });
    expect(attempt.setCookie).toBe("");
    expect(sessionCount(memberId)).toBe(0);
  });

  it("a member's token never carries more than the member holds", async () => {
    const { daemon, memberId } = await withMember();
    const value = `pap_${randomBytes(32).toString("base64url")}`;
    bed.db.run(
      "INSERT INTO api_tokens (id, user_id, name, hint, secret_hash, permissions, created_at, expires_at) VALUES ('t1', $userId, 't', 'abcd', $hash, '[\"pi:read\",\"users:read\",\"system:admin\",\"sessions:read\"]', 0, $exp)",
      { userId: memberId, hash: sha256Hex(value), exp: bed.clock.now() + DAY },
    );
    const caller = daemon.auth.authenticateCredential({ kind: "bearer", value });
    expect(caller?.permissions).toEqual(new Set(["sessions:read"]));
  });

  it("a member cannot create a token above their own permissions", () => {
    const token = createTokenBed();
    try {
      const member = { ...token.confirmed(), permissions: permissionsOf("member") };
      expect(() =>
        token.tokens.create(member, { name: "x", permissions: ["pi:read"], expiresInDays: 7 }),
      ).toThrow(new PapError("forbidden"));
      expect(
        token.tokens.create(member, { name: "x", permissions: ["sessions:read"], expiresInDays: 7 }).value,
      ).toMatch(/^pap_/);
    } finally {
      token.dispose();
    }
  });

  it("records the last sign-in at most once a minute", async () => {
    const { daemon, memberId } = await withMember();
    const login = await memberLogin(daemon);
    const cookie = { kind: "cookie" as const, value: cookieOf(login.setCookie).split("=")[1] ?? "" };
    const seen = () => daemon.auth.users().find((u) => u.id === memberId)?.lastSeenAt;
    daemon.auth.authenticateCredential(cookie);
    const first = seen();
    expect(first).toBe(bed.clock.now());
    await bed.clock.advance(30_000);
    daemon.auth.authenticateCredential(cookie);
    expect(seen()).toBe(first);
    await bed.clock.advance(31_000);
    daemon.auth.authenticateCredential(cookie);
    expect(seen()).toBe(bed.clock.now());
  });
});
