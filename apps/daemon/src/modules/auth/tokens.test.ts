import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  API_TOKEN_PATTERN,
  PapError,
  TOKEN_PERMISSIONS,
  methods,
  type Permission,
} from "@pap/contracts";
import { testCaller } from "../../testing/caller.ts";
import { insertUserRow } from "./testing/users.ts";
import { createTokenBed, DAY, OWNER_ID } from "./testing/token-bed.ts";

let current: ReturnType<typeof createTokenBed> | undefined;
afterEach(() => {
  current?.dispose();
  current = undefined;
});
const bed = () => (current = createTokenBed());
const input = { name: "x", permissions: ["sessions:read" as const], expiresInDays: 7 as const };

describe("api tokens", () => {
  it("creates a token once, shows its value once and stores only its hash", () => {
    const { tokens, db, clock, confirmed } = bed();
    const { token, value } = tokens.create(confirmed(), {
      name: "ci",
      permissions: ["sessions:read"],
      expiresInDays: 90,
    });
    expect(value).toMatch(API_TOKEN_PATTERN);
    expect(token).toEqual({
      id: expect.any(String),
      name: "ci",
      hint: value.slice(-4),
      permissions: ["sessions:read"],
      createdAt: clock.now(),
      expiresAt: clock.now() + 90 * DAY,
      lastUsedAt: null,
    });
    const stored = JSON.stringify(db.all("SELECT * FROM api_tokens"));
    expect(stored).not.toContain(value);
    expect(stored).toContain(createHash("sha256").update(value).digest("hex"));
    expect(JSON.stringify(tokens.list(confirmed()))).not.toContain(value);
  });

  it("needs a fresh step-up, and never takes one from a token caller", () => {
    const { tokens, clock, confirmed } = bed();
    const refused = new PapError("step_up_required");
    expect(() => tokens.create(testCaller({ userId: OWNER_ID }), input)).toThrow(refused);
    expect(() => tokens.create({ ...confirmed(), stepUpUntil: clock.now() }, input)).toThrow(refused);
    expect(() => tokens.create({ ...confirmed(), kind: "token" }, input)).toThrow(refused);
  });

  it("authenticates a live token with its own permissions only, and refuses wrong, unknown, expired and revoked ones", async () => {
    const { tokens, clock, lookups, confirmed } = bed();
    const { token, value } = tokens.create(confirmed(), {
      name: "ci",
      permissions: ["sessions:read", "audit:read"],
      expiresInDays: 7,
    });
    expect(tokens.authenticate(value, { slide: true })).toEqual(
      testCaller({
        userId: OWNER_ID,
        permissions: new Set(["sessions:read", "audit:read"]),
        kind: "token",
        credentialId: token.id,
      }),
    );
    const before = lookups();
    expect(tokens.authenticate("pap_short", { slide: true })).toBeNull();
    expect(tokens.authenticate(`Bearer ${value}`, { slide: true })).toBeNull();
    expect(tokens.authenticate(undefined, { slide: true })).toBeNull();
    expect(lookups()).toBe(before); // refused by the pattern, no database lookup
    expect(tokens.authenticate(`pap_${"A".repeat(43)}`, { slide: true })).toBeNull();
    await clock.advance(7 * DAY);
    expect(tokens.authenticate(value, { slide: true })).toBeNull();
    const second = tokens.create(confirmed(), { ...input, name: "b", expiresInDays: 30 });
    tokens.revoke(confirmed(), second.token.id);
    expect(tokens.authenticate(second.value, { slide: true })).toBeNull();
  });

  it("never gives a token auth or policy:admin, even from a tampered row (M5R64)", () => {
    const { tokens, db, confirmed } = bed();
    const { value } = tokens.create(confirmed(), { ...input, name: "ci" });
    db.run("UPDATE api_tokens SET permissions = $p", {
      p: JSON.stringify(["sessions:read", "auth:admin", "auth:read", "auth:operate", "policy:admin"]),
    });
    expect(tokens.authenticate(value, { slide: false })?.permissions).toEqual(new Set(["sessions:read"]));
    expect(tokens.list(confirmed()).map((t) => t.permissions)).toEqual([["sessions:read"]]);
  });

  it("never grants a permission the owner no longer holds (M5R64)", () => {
    current = createTokenBed({ ownerPermissions: new Set<Permission>(["sessions:read", "auth:admin"]) });
    const { tokens, confirmed } = current;
    const { value } = tokens.create(confirmed(), {
      ...input,
      name: "ci",
      permissions: ["sessions:read", "audit:read"],
    });
    expect(tokens.authenticate(value, { slide: false })?.permissions).toEqual(new Set(["sessions:read"]));
  });

  it("refuses to store auth:*, policy:admin, pi:admin or any non-grantable permission, whatever the request asks (owner Q7 b)", () => {
    const { tokens, db, confirmed } = bed();
    const forbidden = ALL_PERMISSIONS.filter((p) => !TOKEN_PERMISSIONS.includes(p));
    expect(forbidden).toEqual([
      "system:admin",
      "auth:read",
      "auth:operate",
      "auth:admin",
      "sessions:admin",
      "policy:admin",
      "settings:admin",
      "terminal:read",
      "terminal:operate",
      "terminal:admin",
      "pi:admin",
      "lanes:admin",
      "automation:admin",
      "agents:admin",
      "secrets:read",
      "secrets:operate",
      "secrets:admin",
      "users:read",
      "users:operate",
      "users:admin",
    ]);
    const params = methods["auth.tokens.create"].params;
    for (const permission of forbidden) {
      expect(params.safeParse({ ...input, permissions: [permission] }).success).toBe(false);
      expect(params.safeParse({ ...input, permissions: ["sessions:read", permission] }).success).toBe(false);
      // The schema is not the only guard: a request that got past it is refused by the service too.
      expect(() => tokens.create(confirmed(), { ...input, permissions: [permission] } as never)).toThrow(
        new PapError("bad_request"),
      );
      expect(() =>
        tokens.create(confirmed(), { ...input, permissions: ["sessions:read", permission] } as never),
      ).toThrow(new PapError("bad_request"));
    }
    expect(db.all("SELECT * FROM api_tokens")).toEqual([]);
  });

  it("still lists on a read-only database, without the expired ones (R130)", async () => {
    const { tokens, clock, confirmed, readOnlyTokens } = bed();
    tokens.create(confirmed(), { ...input, name: "short" });
    const long = tokens.create(confirmed(), { ...input, name: "long", expiresInDays: 30 });
    await clock.advance(8 * DAY);
    const listed = readOnlyTokens().list(confirmed());
    expect(listed.map((t) => t.id)).toEqual([long.token.id]);
  });

  it("logs a damaged permissions row once by token id, never its value or hash, and grants nothing", () => {
    const { tokens, db, logLines, confirmed } = bed();
    const { token, value } = tokens.create(confirmed(), input);
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.run("UPDATE api_tokens SET permissions = '\"not a list\"'");
    expect(tokens.authenticate(value, { slide: false })?.permissions).toEqual(new Set());
    expect(tokens.authenticate(value, { slide: false })?.permissions).toEqual(new Set());
    const warns = logLines.filter((line) => line.includes("token_row_damaged"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(token.id);
    expect(logLines.join("\n")).not.toContain(value);
    expect(logLines.join("\n")).not.toContain(createHash("sha256").update(value).digest("hex"));
  });

  it("refuses a name with control, bidi or line-separator characters", () => {
    bed();
    const params = methods["auth.tokens.create"].params;
    for (const name of ["a\u0007b", "a\u202Eb", "a\u2028b", "a\u200Bb", "a\u0085b"])
      expect(params.safeParse({ ...input, name }).success).toBe(false);
    expect(params.safeParse({ ...input, name: "ci runner é" }).success).toBe(true);
  });

  it("lets a caller built from a token neither manage tokens nor list them (owner Q7 b)", () => {
    const { tokens, confirmed } = bed();
    const { value } = tokens.create(confirmed(), { ...input, permissions: ["sessions:read", "audit:read"] });
    const caller = tokens.authenticate(value, { slide: false });
    if (!caller) throw new Error("token refused");
    for (const permission of ["auth:read", "auth:operate", "auth:admin", "policy:admin"] as const)
      expect(caller.permissions.has(permission)).toBe(false);
    expect(() => tokens.create(caller, input)).toThrow(new PapError("forbidden"));
    expect(() => tokens.list(caller)).toThrow(new PapError("forbidden"));
    expect(() => tokens.revoke(caller, "tok-0")).toThrow(new PapError("forbidden"));
  });

  it("refuses a caller without auth:admin or auth:read", () => {
    const { tokens, confirmed } = bed();
    const without = (permission: Permission) => ({
      ...confirmed(),
      permissions: new Set(ALL_PERMISSIONS.filter((p) => p !== permission)),
    });
    expect(() => tokens.create(without("auth:admin"), input)).toThrow(new PapError("forbidden"));
    expect(() => tokens.list(without("auth:read"))).toThrow(new PapError("forbidden"));
    expect(() => tokens.revoke(without("auth:admin"), "tok-0")).toThrow(new PapError("forbidden"));
  });

  it("writes last use at most once per 10 minutes, never on a keepalive check, and forgets revoked and expired tokens (M5R66)", async () => {
    const { tokens, clock, writes, confirmed } = bed();
    const a = tokens.create(confirmed(), { ...input, name: "a", expiresInDays: 30 });
    tokens.authenticate(a.value, { slide: false });
    expect(writes()).toBe(0);
    for (let i = 0; i < 5; i++) tokens.authenticate(a.value, { slide: true });
    expect(writes()).toBe(1);
    await clock.advance(10 * 60_000);
    tokens.authenticate(a.value, { slide: true });
    expect(writes()).toBe(2);
    const b = tokens.create(confirmed(), { ...input, name: "b" });
    tokens.authenticate(b.value, { slide: true });
    expect(tokens.lastUseTracked()).toBe(2);
    tokens.revoke(confirmed(), a.token.id);
    expect(tokens.lastUseTracked()).toBe(1);
    await clock.advance(8 * DAY);
    tokens.list(confirmed());
    expect(tokens.lastUseTracked()).toBe(0);
  });

  it("refuses an empty or duplicated list, a lifetime off the list and a 51st token", () => {
    const { tokens, db, confirmed } = bed();
    const create = (patch: object) => () => tokens.create(confirmed(), { ...input, ...patch } as never);
    const params = methods["auth.tokens.create"].params;
    const ok = { name: "x", expiresInDays: 7 };
    expect(params.safeParse({ ...ok, permissions: ["policy:read", "policy:operate"] }).success).toBe(true);
    expect(params.safeParse({ ...ok, permissions: [] }).success).toBe(false);
    expect(params.safeParse({ ...ok, permissions: ["audit:read", "audit:read"] }).success).toBe(false);
    expect(params.safeParse({ permissions: ["audit:read"], expiresInDays: 0, name: "x" }).success).toBe(
      false,
    );
    expect(params.safeParse({ permissions: ["audit:read"], expiresInDays: 14, name: "x" }).success).toBe(
      false,
    );
    expect(params.safeParse({ permissions: ["audit:read"], expiresInDays: 90, name: "" }).success).toBe(
      false,
    );
    expect(create({ permissions: [] })).toThrow(new PapError("bad_request"));
    expect(create({ permissions: ["audit:read", "audit:read"] })).toThrow(new PapError("bad_request"));
    expect(create({ expiresInDays: 14 })).toThrow(new PapError("bad_request"));
    for (let i = 0; i < 50; i++) create({ name: `t${i}` })();
    expect(create({ name: "t50" })).toThrow(new PapError("limit_reached"));
    expect(db.all("SELECT id FROM api_tokens")).toHaveLength(50);
  });

  it("audits creation and revocation without the value, its hash or any secret", () => {
    const { tokens, audit, confirmed, clock } = bed();
    const { token, value } = tokens.create(confirmed(), { ...input, name: "ci" });
    tokens.revoke(confirmed(), token.id);
    expect(audit.lines).toEqual([
      {
        ownerId: OWNER_ID,
        actor: "user",
        kind: "auth",
        reason: "token_created",
        detail: { tokenId: token.id, name: "ci", permissions: 1, expiresAt: clock.now() + 7 * DAY },
      },
      {
        ownerId: OWNER_ID,
        actor: "user",
        kind: "auth",
        reason: "token_revoked",
        detail: { tokenId: token.id },
      },
    ]);
    const text = JSON.stringify(audit.lines);
    expect(text).not.toContain(value);
    expect(text).not.toContain(createHash("sha256").update(value).digest("hex"));
  });

  it("answers not_found for another owner's or an unknown id, and deletes expired tokens on list", async () => {
    const { tokens, db, clock, confirmed } = bed();
    const { token } = tokens.create(confirmed(), input);
    insertUserRow(db, { id: "o2", username: "two" });
    const other = { ...confirmed(), userId: "o2" };
    expect(() => tokens.revoke(other, token.id)).toThrow(new PapError("not_found"));
    expect(() => tokens.revoke(confirmed(), "nope")).toThrow(new PapError("not_found"));
    expect(tokens.list(other)).toEqual([]);
    await clock.advance(7 * DAY);
    expect(tokens.list(confirmed())).toEqual([]);
    expect(db.all("SELECT id FROM api_tokens")).toEqual([]);
  });

  it("parses a stored token with a memory permission and keeps the others only", async () => {
    const { tokens, db, confirmed } = bed();
    const { token, value } = tokens.create(confirmed(), input);
    db.run("UPDATE api_tokens SET permissions = $p WHERE id = $id", {
      p: JSON.stringify(["memory:read", "memory:admin", "sessions:read"]),
      id: token.id,
    });
    expect(tokens.list(confirmed())[0]?.permissions).toEqual(["sessions:read"]);
    expect(tokens.authenticate(value, { slide: true })?.permissions).toEqual(new Set(["sessions:read"]));
    expect(ALL_PERMISSIONS.some((p) => p.startsWith("memory:"))).toBe(false);
  });
});
