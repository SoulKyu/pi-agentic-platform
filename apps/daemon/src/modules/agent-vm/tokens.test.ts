import { timingSafeEqual } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLaunchTokens, type LaunchTokens } from "./tokens.ts";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const AGENT = { kind: "agent", id: "reviewer-0a1b" } as const;
const OTHER = { kind: "agent", id: "writer-2c3d" } as const;
const PROJECT = { kind: "project", id: "6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d11" } as const;
let tokens: LaunchTokens;

beforeEach(() => {
  tokens = createLaunchTokens();
  vi.mocked(timingSafeEqual).mockClear();
});

describe("launch tokens", () => {
  it("accepts an issued pair for its agent, again and again (the guest and every worker present it)", () => {
    const { launchId, token } = tokens.issue(AGENT);
    expect(launchId).toMatch(/^[0-9a-f]{32}$/);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    for (let n = 0; n < 3; n++) expect(tokens.check(AGENT, launchId, token)).toBe(true);
  });

  // Mutant "drop the agent-id check" (`entry.agentId !== agentId` removed): this case accepts agent B on A's launch.
  it("refuses a valid token presented with another agent's id", () => {
    const { launchId, token } = tokens.issue(AGENT);
    expect(tokens.check(OTHER, launchId, token)).toBe(false);
  });

  it("a token issued for one box is refused for another", () => {
    const { launchId, token } = tokens.issue(PROJECT);
    expect(tokens.check(PROJECT, launchId, token)).toBe(true);
    expect(tokens.check(AGENT, launchId, token)).toBe(false);
    expect(
      tokens.check({ kind: "project", id: "11111111-1111-4111-8111-111111111111" }, launchId, token),
    ).toBe(false);
    // The same text as an agent id never names a project box.
    expect(tokens.check({ kind: "agent", id: PROJECT.id }, launchId, token)).toBe(false);
  });

  it("refuses an unknown launch and a revoked one, the token being right", () => {
    const { launchId, token } = tokens.issue(AGENT);
    expect(tokens.check(AGENT, "0".repeat(32), token)).toBe(false);
    tokens.revoke(launchId);
    expect(tokens.check(AGENT, launchId, token)).toBe(false);
  });

  // Mutant "hex shape guard dropped": the `zz` cases accept a valid token plus junk.
  it("refuses a token with one changed character, another length, or characters that are not hex", () => {
    const { launchId, token } = tokens.issue(AGENT);
    const flipped = `${token[0] === "a" ? "b" : "a"}${token.slice(1)}`;
    expect(tokens.check(AGENT, launchId, flipped)).toBe(false);
    expect(tokens.check(AGENT, launchId, token.slice(0, -2))).toBe(false);
    expect(tokens.check(AGENT, launchId, `${token}00`)).toBe(false);
    expect(tokens.check(AGENT, launchId, "")).toBe(false);
    // Buffer.from(..., "hex") stops at the first non-hex pair: the brief's code accepted a valid token plus junk.
    expect(tokens.check(AGENT, launchId, `${token}zz`)).toBe(false);
    expect(tokens.check(AGENT, launchId, `${token.slice(0, 62)}zz`)).toBe(false);
    expect(tokens.check(AGENT, launchId, token.toUpperCase())).toBe(false);
  });

  it("revokes one launch only", () => {
    const first = tokens.issue(AGENT);
    const second = tokens.issue(AGENT);
    tokens.revoke(first.launchId);
    expect(tokens.check(AGENT, second.launchId, second.token)).toBe(true);
  });

  it("gives every launch its own id, token and a relay key distinct from the token (64 hex)", () => {
    const first = tokens.issue(AGENT);
    const second = tokens.issue(AGENT);
    expect(first.launchId).not.toBe(second.launchId);
    expect(first.token).not.toBe(second.token);
    expect(first.relayKey).toMatch(/^[0-9a-f]{64}$/);
    expect(first.relayKey).not.toBe(first.token);
    expect(first.relayKey).not.toBe(second.relayKey);
  });

  // Mutant "timingSafeEqual replaced by Buffer.equals": this case sees no call.
  it("compares in constant time (timingSafeEqual) and never on tokens of unequal length", () => {
    const { launchId, token } = tokens.issue(AGENT);
    tokens.check(AGENT, launchId, token);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
    tokens.check(AGENT, launchId, token.slice(0, -2));
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
  });
});
