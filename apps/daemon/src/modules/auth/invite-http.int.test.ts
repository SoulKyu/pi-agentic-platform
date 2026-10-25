import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call, cookieOf, ownerCookie, startDaemon, type Daemon } from "./testing/ceremony.ts";
import { createAuthTestBed, PASSWORD, type AuthTestBed } from "./testing/fixture.ts";

const ORIGIN = "http://localhost:7777";
const tokenOf = (url: string) => new URL(url).hash.replace("#token=", "");

let bed: AuthTestBed;
let daemon: Daemon;
let owner: string;
let ownerId: string;
beforeEach(async () => {
  bed = createAuthTestBed();
  daemon = startDaemon(bed, ORIGIN);
  owner = await ownerCookie(daemon);
  ownerId = daemon.auth.ownerId() ?? "";
});
afterEach(() => bed.dispose());

const invite = () => tokenOf(daemon.auth.invites.create(ownerId, null, ORIGIN).url);
const accept = (token: string, username: string, cookie?: string) =>
  call(daemon, "/auth/invite/accept", { token, username, password: PASSWORD }, cookie);
const idOf = (name: string) =>
  bed.db.get<{ id: string }>("SELECT id FROM users WHERE username = $name", { name })?.id;
const memberCount = () =>
  bed.db.get<{ c: number }>("SELECT count(*) AS c FROM users WHERE role = 'member'")?.c;
const code = (reply: { body: Record<string, unknown> | null }) =>
  (reply.body?.error as { code?: string } | undefined)?.code;

describe("invitation routes", () => {
  it("accepting creates a member, starts a password session and audits both ends", async () => {
    const token = invite();
    const info = await call(daemon, "/auth/invite/info", { token });
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ inviter: "owner" });
    const reply = await accept(token, "mia");
    expect(reply.status).toBe(204);
    expect(reply.setCookie).toContain("pap_session=");
    expect(daemon.auth.authenticateCookieHeader(cookieOf(reply.setCookie))?.userId).toBe(idOf("mia"));
    expect(
      bed.db.get<{ method: string }>(
        "SELECT method FROM auth_sessions WHERE rowid = (SELECT max(rowid) FROM auth_sessions)",
      )?.method,
    ).toBe("password");
    expect(bed.audited.map((line) => line.reason)).toEqual(
      expect.arrayContaining(["user_invited", "member_created"]),
    );
    expect(daemon.auth.invites.pending()).toEqual([]);
  });

  it("two concurrent accepts create one member", async () => {
    const token = invite();
    const replies = await Promise.all([accept(token, "mia"), accept(token, "max")]);
    expect(replies.map((r) => r.status).sort()).toEqual([204, 404]);
    expect(memberCount()).toBe(1);
  });

  it("a revoked invitation answers invite_invalid", async () => {
    const { url, invite: row } = daemon.auth.invites.create(ownerId, null, ORIGIN);
    daemon.auth.invites.revoke(row.id);
    const reply = await accept(tokenOf(url), "mia");
    expect(reply.status).toBe(404);
    expect(code(reply)).toBe("invite_invalid");
    expect(memberCount()).toBe(0);
  });

  it("a taken username keeps the invitation usable and counts the 409", async () => {
    const token = invite();
    const taken = await accept(token, "OWNER");
    expect(taken.status).toBe(409);
    expect(code(taken)).toBe("username_taken");
    expect(daemon.auth.invites.pending()).toHaveLength(1);
    // The 409 was counted: the address now backs off.
    expect((await accept(token, "mia")).status).toBe(429);
    await bed.clock.advance(2000);
    expect((await accept(token, "mia")).status).toBe(204);
  });

  it("accepting with a live cookie revokes that session", async () => {
    expect(daemon.auth.authenticateCookieHeader(owner)).not.toBeNull();
    const reply = await accept(invite(), "mia", owner);
    expect(reply.status).toBe(204);
    expect(daemon.auth.authenticateCookieHeader(owner)).toBeNull();
    expect(daemon.auth.authenticateCookieHeader(cookieOf(reply.setCookie))?.userId).toBe(idOf("mia"));
  });

  it("failed infos and accepts are throttled per IP, and never delay the owner's password sign-in from the same IP", async () => {
    const bad = "x".repeat(43);
    const first = await call(daemon, "/auth/invite/info", { token: bad });
    expect(first.status).toBe(404);
    expect(code(first)).toBe("invite_invalid");
    const second = await call(daemon, "/auth/invite/info", { token: bad });
    expect(second.status).toBe(429);
    expect((await accept(bad, "mia")).status).toBe(429);
    // Same address (the test socket has none, so one bucket): the owner still signs in at once.
    const login = await call(daemon, "/auth/login", { username: "owner", password: PASSWORD });
    expect(login.status).toBe(200);
    // And the reverse: the password throttle is not the invitation one.
    expect(bed.db.get<{ c: number }>("SELECT count(*) AS c FROM invite_throttle")?.c).toBe(1);
  });
});
