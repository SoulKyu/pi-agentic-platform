import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../kernel/ids.ts";
import { ownerCookie, startDaemon, type Daemon } from "./testing/ceremony.ts";
import { createAuthTestBed, type AuthTestBed } from "./testing/fixture.ts";

const DAY = 24 * 60 * 60 * 1000;
const tokenOf = (url: string) => new URL(url).hash.replace("#token=", "");

let bed: AuthTestBed;
let daemon: Daemon;
let ownerId: string;
beforeEach(async () => {
  bed = createAuthTestBed();
  daemon = startDaemon(bed, "http://localhost:7777");
  await ownerCookie(daemon);
  ownerId = daemon.auth.ownerId() ?? "";
});
afterEach(() => bed.dispose());

const infoOf = (url: string) => daemon.auth.invites.info(tokenOf(url));

describe("invitations", () => {
  it("stores only the token's hash", () => {
    const { url } = daemon.auth.invites.create(ownerId, "mia", "http://localhost:7777");
    const token = tokenOf(url);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = bed.db.all<Record<string, unknown>>("SELECT * FROM invitations");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(sha256Hex(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("an invitation expires after 24 hours", async () => {
    const { url, expiresAt } = daemon.auth.invites.create(ownerId, null, "http://localhost:7777");
    expect(expiresAt).toBe(bed.clock.now() + DAY);
    await bed.clock.advance(DAY - 1);
    expect(infoOf(url)).toEqual({ inviter: "owner", expiresAt });
    expect(daemon.auth.invites.pending()).toHaveLength(1);
    await bed.clock.advance(1);
    expect(infoOf(url)).toBeNull();
    expect(daemon.auth.invites.pending()).toEqual([]);
  });

  it("a revoked invitation answers invite_invalid", () => {
    const { url, invite } = daemon.auth.invites.create(ownerId, null, "http://localhost:7777");
    expect(daemon.auth.invites.revoke(invite.id)).toBe(true);
    expect(daemon.auth.invites.revoke(invite.id)).toBe(false);
    expect(infoOf(url)).toBeNull();
  });

  it("the link uses the caller's allowed origin, never a Host header", () => {
    const { auth } = bed.start(
      "http://localhost:7777",
      new Set(["http://localhost:7777", "https://pap.lan"]),
    );
    const allowed = auth.invites.create(ownerId, null, "https://pap.lan");
    expect(allowed.url.startsWith("https://pap.lan/invite#token=")).toBe(true);
    const forged = auth.invites.create(ownerId, null, "https://evil.example");
    expect(forged.url.startsWith("http://localhost:7777/invite#token=")).toBe(true);
  });
});
