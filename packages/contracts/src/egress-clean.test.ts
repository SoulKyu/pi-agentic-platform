import { describe, expect, it } from "vitest";
import { cleansContent } from "./egress-clean.ts";

const trusted = ["docs.example.com"];

describe("cleansContent", () => {
  it("is true for a CONNECT on 443 to a trusted source", () => {
    expect(cleansContent("connect", 443, "docs.example.com", trusted)).toBe(true);
  });

  it.each([
    ["another port", "connect", 8443, "docs.example.com"],
    ["plain http", "http", 80, "docs.example.com"],
    ["http on 443", "http", 443, "docs.example.com"],
    ["an untrusted host", "connect", 443, "other.example.com"],
    ["an IP literal", "connect", 443, "192.0.2.7"],
  ] as const)("is false for %s", (_name, kind, port, host) => {
    expect(cleansContent(kind, port, host, trusted)).toBe(false);
  });
});
