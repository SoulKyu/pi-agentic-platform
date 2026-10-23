import { describe, expect, it } from "vitest";
import { normalizeHost } from "./allow.ts";

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
