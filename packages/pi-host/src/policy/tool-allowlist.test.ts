import { describe, expect, it } from "vitest";
import {
  allowlistVerdict,
  NOT_ALLOWLISTED,
  NOT_ALLOWLISTED_MODEL_REASON,
  pinAllowlist,
  UNATTENDED_UNKNOWN,
  unattendedVerdict,
} from "./tool-allowlist.ts";

describe("allowlistVerdict", () => {
  it("blocks by exact name", () => {
    for (const name of ["Read", "read ", "", "bash"])
      expect(allowlistVerdict(["read"], name)).toEqual({
        outcome: "block",
        reason: NOT_ALLOWLISTED,
        modelReason: NOT_ALLOWLISTED_MODEL_REASON,
      });
    expect(allowlistVerdict(["read"], "read")).toBeNull();
  });

  it("blocks every tool under an empty list and lets everything on without a list", () => {
    expect(allowlistVerdict([], "read")?.outcome).toBe("block");
    expect(allowlistVerdict(null, "bash")).toBeNull();
  });
});

describe("unattendedVerdict", () => {
  it("blocks the unknown category only, and only while unattended", () => {
    expect(unattendedVerdict(true, "unknown")).toMatchObject({
      outcome: "block",
      reason: UNATTENDED_UNKNOWN,
    });
    expect(unattendedVerdict(false, "unknown")).toBeNull();
    for (const category of ["exec", "external-write", "read"] as const)
      expect(unattendedVerdict(true, category)).toBeNull();
  });
});

describe("pinAllowlist", () => {
  it("lets the pinned list stand when the rules carry none, or a wider one", () => {
    expect(pinAllowlist(null, ["read"])).toEqual(["read"]);
    expect(pinAllowlist(["read", "bash"], ["read"])).toEqual(["read"]);
  });

  it("lets the rules narrow the pinned list", () => {
    expect(pinAllowlist(["read"], ["read", "grep"])).toEqual(["read"]);
    expect(pinAllowlist([], ["read"])).toEqual([]);
  });

  it("follows the rules when nothing is pinned", () => {
    expect(pinAllowlist(null, null)).toBeNull();
    expect(pinAllowlist(["a"], null)).toEqual(["a"]);
  });
});
