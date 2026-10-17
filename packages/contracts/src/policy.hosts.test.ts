import { describe, expect, it } from "vitest";
import {
  ApprovalRequestRecord,
  Dialog,
  HostPattern,
  lastLabelStartsWithDigit,
  PolicyRules,
  TrustedHost,
} from "./index.ts";

describe("TrustedHost (owner a1, a2)", () => {
  it("accepts an exact host, punycode included", () => {
    expect(TrustedHost.safeParse("api.example.com").success).toBe(true);
    expect(TrustedHost.safeParse("xn--bcher-kva.example").success).toBe(true);
  });
  it("refuses a wildcard, a bare name, localhost, an IP address and capitals", () => {
    for (const host of [
      "*.example.com",
      "example",
      "localhost",
      "93.184.216.34",
      "Example.com",
      "a.example.com:8443",
    ])
      expect(TrustedHost.safeParse(host).success, host).toBe(false);
  });
  it("refuses what the egress proxy calls an IP literal: a last label that starts with a digit", () => {
    for (const host of ["127.1", "a.127.0x1", "x.2130706433", "example.1com", "10.0.0.1"])
      expect(TrustedHost.safeParse(host).success, host).toBe(false);
    expect(TrustedHost.safeParse("1.example.com").success).toBe(true);
    expect(TrustedHost.safeParse("api2.example2.io").success).toBe(true);
    expect(HostPattern.safeParse("*.127.0x1").success).toBe(false);
    expect(lastLabelStartsWithDigit("a.b.9")).toBe(true);
    expect(lastLabelStartsWithDigit("a.b9")).toBe(false);
  });
});

const card = {
  type: "approval_request" as const,
  id: "d1",
  category: "read" as const,
  title: "t",
  message: "m",
  tool: "network_request",
  key: "a".repeat(64),
};
const dialog = {
  id: "d1",
  method: "approval" as const,
  title: "t",
  category: "read" as const,
  tool: "network_request",
};

describe("the host of an approval card (M11R222)", () => {
  it("is present exactly when the card offers the host answer, in the record", () => {
    const answers = ["deny", "host"];
    expect(ApprovalRequestRecord.safeParse({ ...card, answers, host: "api.example.com" }).success).toBe(true);
    expect(ApprovalRequestRecord.safeParse({ ...card, answers }).success).toBe(false);
    expect(
      ApprovalRequestRecord.safeParse({ ...card, answers: ["deny", "once"], host: "api.example.com" })
        .success,
    ).toBe(false);
    expect(ApprovalRequestRecord.safeParse({ ...card, answers: ["deny", "once"] }).success).toBe(true);
    expect(ApprovalRequestRecord.safeParse({ ...card, answers, host: "*.example.com" }).success).toBe(false);
  });
  it("is present exactly when the card offers the host answer, in the dialog", () => {
    const answers = ["deny", "host"];
    expect(Dialog.safeParse({ ...dialog, answers, host: "api.example.com" }).success).toBe(true);
    expect(Dialog.safeParse({ ...dialog, answers }).success).toBe(false);
    expect(Dialog.safeParse({ ...dialog, answers: ["deny", "once"], host: "api.example.com" }).success).toBe(
      false,
    );
    expect(Dialog.safeParse({ ...dialog, answers: ["deny", "once"] }).success).toBe(true);
  });
});

describe("PolicyRules host lists", () => {
  const rules = { profile: "agent-thread", approvalMode: "supervised" };
  it("defaults both lists to empty", () => {
    const parsed = PolicyRules.parse(rules);
    expect(parsed.trustedSources).toEqual([]);
    expect(parsed.hostGrants).toEqual([]);
  });
  it("bounds them at 20 and 64 and refuses a wildcard", () => {
    const hosts = (count: number) => Array.from({ length: count }, (_, index) => `h${index}.example.com`);
    expect(PolicyRules.safeParse({ ...rules, trustedSources: hosts(20) }).success).toBe(true);
    expect(PolicyRules.safeParse({ ...rules, trustedSources: hosts(21) }).success).toBe(false);
    expect(PolicyRules.safeParse({ ...rules, hostGrants: hosts(64) }).success).toBe(true);
    expect(PolicyRules.safeParse({ ...rules, hostGrants: hosts(65) }).success).toBe(false);
    expect(PolicyRules.safeParse({ ...rules, hostGrants: ["*.example.com"] }).success).toBe(false);
  });
  it("stays strict", () => {
    expect(PolicyRules.safeParse({ ...rules, extra: 1 }).success).toBe(false);
  });
});
