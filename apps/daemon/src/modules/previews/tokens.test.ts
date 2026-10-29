import { PapError, type BoxRef } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createPreviewTokens, PREVIEW_TOKEN_LIMITS } from "./tokens.ts";

const BOX_A: BoxRef = { kind: "agent", id: "a1" };
const BOX_B: BoxRef = { kind: "agent", id: "b2" };
const MIN = 60_000;

function setup() {
  const clock = createFakeClock();
  return { clock, tokens: createPreviewTokens(clock) };
}
const service = (ownerId = "u1", serviceId = "s1", box: BoxRef = BOX_A, sources: readonly string[] = []) => ({
  ownerId,
  box,
  serviceId,
  port: 8000,
  sources,
});
const artifact = (
  over: Partial<{
    ownerId: string;
    sessionId: string;
    entryId: string;
    fenceIndex: number;
    html: string;
  }> = {},
) => ({
  ownerId: "u1",
  sessionId: "ses",
  entryId: "e1",
  fenceIndex: 0,
  html: "<p>hi</p>",
  ...over,
});
const codeOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error instanceof PapError ? error.code : error;
  }
  return null;
};

describe("preview tokens", () => {
  it("mints 43-character base64url tokens that resolve only as their own kind", () => {
    const { tokens } = setup();
    const svc = tokens.mintService(service());
    const art = tokens.mintArtifact(artifact());
    expect(svc.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(art.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokens.resolve("service", svc.token)).toMatchObject({ kind: "service", serviceId: "s1" });
    expect(tokens.resolve("artifact", svc.token)).toBeNull();
    expect(tokens.resolve("artifact", art.token)).toMatchObject({ kind: "artifact", entryId: "e1" });
    expect(tokens.resolve("service", art.token)).toBeNull();
    expect(tokens.resolve("service", "nope")).toBeNull();
  });

  it("revokes a service token 5 minutes after its last renewal, and renewal moves the end", async () => {
    const { clock, tokens } = setup();
    const { token, lease, until } = tokens.mintService(service());
    expect(until - clock.now()).toBe(5 * MIN);
    await clock.advance(5 * MIN - 1);
    expect(tokens.resolve("service", token)).not.toBeNull();
    await clock.advance(1);
    expect(tokens.resolve("service", token)).toBeNull();
    expect(tokens.renew("u1", lease)).toBeNull();

    const second = tokens.mintService(service("u1", "s2"));
    await clock.advance(4 * MIN);
    expect(tokens.renew("u1", second.lease)).toBe(clock.now() + 5 * MIN);
    await clock.advance(4 * MIN);
    expect(tokens.resolve("service", second.token)).not.toBeNull();
    await clock.advance(MIN);
    expect(tokens.resolve("service", second.token)).toBeNull();
  });

  it("refuses a renewal by another owner and of an unknown lease", () => {
    const { tokens } = setup();
    const { lease, token } = tokens.mintService(service());
    expect(tokens.renew("u2", lease)).toBeNull();
    expect(tokens.renew("u1", "0".repeat(32))).toBeNull();
    expect(tokens.resolve("service", token)).not.toBeNull();
  });

  it("kills an artifact token after one hour, whatever happens", async () => {
    const { clock, tokens } = setup();
    const { token } = tokens.mintArtifact(artifact());
    await clock.advance(59 * MIN + 59_999);
    expect(tokens.resolve("artifact", token)).not.toBeNull();
    await clock.advance(1);
    expect(tokens.resolve("artifact", token)).toBeNull();
  });

  it("revokes by service, by box and by owner, and nothing else", () => {
    const { tokens } = setup();
    const a = tokens.mintService(service("u1", "s1", BOX_A));
    const b = tokens.mintService(service("u1", "s2", BOX_B));
    const c = tokens.mintService(service("u2", "s3", BOX_B));
    const art = tokens.mintArtifact(artifact({ ownerId: "u2" }));
    expect(tokens.revokeService("s1")).toBe(1);
    expect(tokens.resolve("service", a.token)).toBeNull();
    expect(tokens.resolve("service", b.token)).not.toBeNull();
    expect(tokens.revokeBox(BOX_A)).toBe(0);
    expect(tokens.revokeBox(BOX_B)).toBe(2);
    expect(tokens.resolve("service", c.token)).toBeNull();
    expect(tokens.resolve("artifact", art.token)).not.toBeNull();
    const d = tokens.mintService(service("u1", "s4", BOX_A));
    expect(tokens.revokeOwner("u2")).toBe(1);
    expect(tokens.resolve("artifact", art.token)).toBeNull();
    expect(tokens.resolve("service", d.token)).not.toBeNull();
    expect(tokens.revokeOwner("u1")).toBe(1);
  });

  it("refuses the 33rd service token of an owner and the 257th of all, evicting none", () => {
    const { tokens } = setup();
    const first = tokens.mintService(service("u0", "first"));
    for (let i = 1; i < 32; i++) tokens.mintService(service("u0", `s${i}`));
    expect(codeOf(() => tokens.mintService(service("u0", "x")))).toBe("limit_reached");
    expect(tokens.resolve("service", first.token)).not.toBeNull();
    for (let owner = 1; owner < 8; owner++)
      for (let i = 0; i < 32; i++) tokens.mintService(service(`o${owner}`, `s${owner}-${i}`));
    expect(codeOf(() => tokens.mintService(service("late", "y")))).toBe("limit_reached");
    expect(tokens.resolve("service", first.token)).not.toBeNull();
  });

  it("refuses the 33rd artifact token of an owner and the 129th of all", () => {
    const { tokens } = setup();
    for (let i = 0; i < 32; i++) tokens.mintArtifact(artifact({ fenceIndex: i }));
    expect(codeOf(() => tokens.mintArtifact(artifact({ fenceIndex: 99 })))).toBe("limit_reached");
    for (let owner = 1; owner < 4; owner++)
      for (let i = 0; i < 32; i++) tokens.mintArtifact(artifact({ ownerId: `o${owner}`, fenceIndex: i }));
    expect(codeOf(() => tokens.mintArtifact(artifact({ ownerId: "late" })))).toBe("limit_reached");
  });

  it("makes room again once tokens expire", async () => {
    const { clock, tokens } = setup();
    for (let i = 0; i < 32; i++) tokens.mintService(service("u1", `s${i}`));
    expect(codeOf(() => tokens.mintService(service("u1", "x")))).toBe("limit_reached");
    await clock.advance(PREVIEW_TOKEN_LIMITS.leaseMs);
    expect(codeOf(() => tokens.mintService(service("u1", "x")))).toBeNull();
  });

  it("refuses an artifact over 256 KiB of UTF-8", () => {
    const { tokens } = setup();
    const limit = PREVIEW_TOKEN_LIMITS.artifactBytes;
    expect(codeOf(() => tokens.mintArtifact(artifact({ html: "a".repeat(limit) })))).toBeNull();
    expect(codeOf(() => tokens.mintArtifact(artifact({ entryId: "e2", html: "a".repeat(limit + 1) })))).toBe(
      "payload_too_large",
    );
    // 2 bytes per character: under the limit in characters, over it in bytes.
    expect(
      codeOf(() => tokens.mintArtifact(artifact({ entryId: "e3", html: "é".repeat(limit / 2 + 1) }))),
    ).toBe("payload_too_large");
  });

  it("a service token is held nowhere in the store, only its hash", () => {
    const { tokens } = setup();
    const seen: unknown[] = [];
    const set = Map.prototype.set;
    const spy = vi.spyOn(Map.prototype, "set").mockImplementation(function (
      this: Map<unknown, unknown>,
      key,
      value,
    ) {
      seen.push(key, value);
      return set.call(this, key, value);
    });
    try {
      const { token } = tokens.mintService(service());
      expect(seen.length).toBeGreaterThan(0);
      expect(JSON.stringify(seen)).not.toContain(token);
    } finally {
      spy.mockRestore();
    }
  });

  it("the 40th toggle of one fence reuses its token, and the cap counts it once", () => {
    const { tokens } = setup();
    const first = tokens.mintArtifact(artifact());
    for (let i = 0; i < 39; i++) expect(tokens.mintArtifact(artifact()).token).toBe(first.token);
    expect(codeOf(() => tokens.mintArtifact(artifact({ fenceIndex: 1 })))).toBeNull();
    for (let i = 2; i < 32; i++) tokens.mintArtifact(artifact({ fenceIndex: i }));
    expect(codeOf(() => tokens.mintArtifact(artifact({ fenceIndex: 40 })))).toBe("limit_reached");
    expect(tokens.mintArtifact(artifact()).token).toBe(first.token);
  });

  it("another entry, fence, session or owner gets its own token", () => {
    const { tokens } = setup();
    const base = tokens.mintArtifact(artifact()).token;
    const others = [
      tokens.mintArtifact(artifact({ entryId: "e2" })).token,
      tokens.mintArtifact(artifact({ fenceIndex: 1 })).token,
      tokens.mintArtifact(artifact({ sessionId: "other" })).token,
      tokens.mintArtifact(artifact({ ownerId: "u2" })).token,
    ];
    expect(new Set([base, ...others]).size).toBe(5);
    expect(tokens.resolve("artifact", others[3] ?? "")).toMatchObject({ ownerId: "u2" });
  });

  it("a token with under 5 minutes left is replaced, and the old one still dies at its hour", async () => {
    const { clock, tokens } = setup();
    const old = tokens.mintArtifact(artifact());
    await clock.advance(55 * MIN);
    expect(tokens.mintArtifact(artifact()).token).toBe(old.token);
    await clock.advance(1);
    const fresh = tokens.mintArtifact(artifact());
    expect(fresh.token).not.toBe(old.token);
    expect(tokens.resolve("artifact", old.token)).not.toBeNull();
    await clock.advance(5 * MIN - 1);
    expect(tokens.resolve("artifact", old.token)).toBeNull();
    expect(tokens.resolve("artifact", fresh.token)).not.toBeNull();
  });

  it("a revoked artifact owner gets a new token for the same fence", () => {
    const { tokens } = setup();
    const first = tokens.mintArtifact(artifact());
    expect(tokens.revokeOwner("u1")).toBe(1);
    const again = tokens.mintArtifact(artifact());
    expect(again.token).not.toBe(first.token);
    expect(tokens.resolve("artifact", first.token)).toBeNull();
    expect(tokens.resolve("artifact", again.token)).not.toBeNull();
  });

  it("an unmounted pane frees its place: close revokes the owner's own lease and its token", () => {
    const { tokens } = setup();
    const { token, lease } = tokens.mintService(service());
    expect(tokens.close("u2", lease)).toBe(false);
    expect(tokens.resolve("service", token)).not.toBeNull();
    expect(tokens.close("u1", lease)).toBe(true);
    expect(tokens.resolve("service", token)).toBeNull();
    expect(tokens.renew("u1", lease)).toBeNull();
    expect(tokens.close("u1", lease)).toBe(false);
    for (let i = 0; i < 32; i++) tokens.mintService(service("u1", `s${i}`));
  });

  it("the grant freezes the host sources it was minted with", () => {
    const { tokens } = setup();
    const sources = ["https://a.test"];
    const { token } = tokens.mintService(service("u1", "s1", BOX_A, sources));
    sources.push("https://evil.test");
    const grant = tokens.resolve("service", token);
    expect(grant?.kind === "service" ? grant.sources : null).toEqual(["https://a.test"]);
  });

  it("an expired artifact leaves nothing behind: its fence is forgotten at the sweep", async () => {
    const maps = new Set<Map<unknown, unknown>>();
    const set = Map.prototype.set;
    const spy = vi.spyOn(Map.prototype, "set").mockImplementation(function (
      this: Map<unknown, unknown>,
      key,
      value,
    ) {
      maps.add(this);
      return set.call(this, key, value);
    });
    const { clock, tokens } = setup();
    let first: { token: string };
    try {
      first = tokens.mintArtifact(artifact());
    } finally {
      spy.mockRestore();
    }
    expect(maps.size).toBeGreaterThan(0);
    await clock.advance(PREVIEW_TOKEN_LIMITS.artifactMs);
    tokens.sweep();
    expect([...maps].every((map) => map.size === 0)).toBe(true);
    expect(tokens.resolve("artifact", first.token)).toBeNull();
    const again = tokens.mintArtifact(artifact());
    expect(again.token).not.toBe(first.token);
    for (let i = 1; i < 32; i++) tokens.mintArtifact(artifact({ fenceIndex: i }));
    expect(codeOf(() => tokens.mintArtifact(artifact({ fenceIndex: 99 })))).toBe("limit_reached");
  });
});
