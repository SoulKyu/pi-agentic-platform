import { describe, expect, it } from "vitest";
import { allowed, type EgressScope, normalizeHost } from "./allow.ts";

const scope = (over: Partial<EgressScope> = {}, grants: string[] = []): EgressScope => ({
  ownerId: "u1",
  agentId: "atlas-1a2b",
  sessionId: "s1",
  hosts: ["api.example.com", "*.x.example"],
  trustedSources: [],
  grants: () => grants,
  ...over,
});

describe("allowed", () => {
  it("a null list lets any host through", () => {
    expect(allowed(scope({ hosts: null }), "anything.example")).toBe(true);
  });

  it("matches an exact entry, and a wildcard for subdomains only", () => {
    expect(allowed(scope(), "api.example.com")).toBe(true);
    expect(allowed(scope(), "a.x.example")).toBe(true);
    expect(allowed(scope(), "b.a.x.example")).toBe(true);
    expect(allowed(scope(), "x.example")).toBe(false);
    expect(allowed(scope(), "evilx.example")).toBe(false);
    expect(allowed(scope(), "api.example.com.evil.test")).toBe(false);
    expect(allowed(scope(), "other.example.com")).toBe(false);
  });

  it("an empty list lets nothing through", () => {
    expect(allowed(scope({ hosts: [] }), "api.example.com")).toBe(false);
  });

  it("a trusted source off the list is allowed (exact host only)", () => {
    const s = scope({ trustedSources: ["github.com"] });
    expect(allowed(s, "github.com")).toBe(true);
    expect(allowed(s, "api.github.com")).toBe(false);
  });

  it("a grant is read live: allowed, then dropped, then refused", () => {
    const grants = ["granted.example"];
    const s = scope({}, grants);
    expect(allowed(s, "granted.example")).toBe(true);
    grants.length = 0;
    expect(allowed(s, "granted.example")).toBe(false);
  });
});

describe("normalizeHost", () => {
  it("lower-cases and drops one final dot", () => {
    expect(normalizeHost("API.Example.COM.")).toEqual({ host: "api.example.com" });
    expect(normalizeHost("api.example.com..")).toEqual({ reason: "bad_target" });
  });

  it("takes xn-- labels, refuses raw non-ASCII, underscores and a single label", () => {
    expect(normalizeHost("xn--bcher-kva.example")).toEqual({ host: "xn--bcher-kva.example" });
    for (const raw of ["a_b.example", "localhost", "b\u00fccher.example", "", "a b.example", "-a.example"]) {
      expect(normalizeHost(raw)).toEqual({ reason: "bad_target" });
    }
  });

  it("an IP literal in any spelling is ip_literal", () => {
    for (const raw of [
      "127.0.0.1",
      "[::1]",
      "::1",
      "169.254.169.254",
      "127.1",
      "0x7f.0.0.1",
      "2130706433",
      "127.0x1",
      "1.0x1",
      "a.1abc",
    ]) {
      expect(normalizeHost(raw)).toEqual({ reason: "ip_literal" });
    }
  });

  it("refuses a name past 253 characters or a label past 63", () => {
    expect(normalizeHost(`${"a".repeat(64)}.example`)).toEqual({ reason: "bad_target" });
    expect(normalizeHost(`${"a.".repeat(130)}example`)).toEqual({ reason: "bad_target" });
  });
});
