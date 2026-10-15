import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  API_TOKEN_PATTERN,
  MAX_TOKENS_PER_USER,
  methods,
  TOKEN_LIFETIMES_DAYS,
  TOKEN_PERMISSIONS,
  TokenPermission,
} from "./index.ts";

describe("token contract", () => {
  it("lets a token hold every permission except auth:*, terminal:*, policy:admin and pi:admin, in catalogue order", () => {
    expect(TOKEN_PERMISSIONS).toEqual(
      ALL_PERMISSIONS.filter(
        (p) =>
          !p.startsWith("auth:") &&
          !p.startsWith("terminal:") &&
          p !== "policy:admin" &&
          p !== "pi:admin" &&
          p !== "lanes:admin",
      ),
    );
    expect(TOKEN_PERMISSIONS).not.toContain("policy:admin");
    expect(TOKEN_PERMISSIONS).not.toContain("pi:admin");
    expect(TokenPermission.safeParse("pi:admin").success).toBe(false);
    expect(TokenPermission.safeParse("pi:read").success).toBe(true);
    expect(TOKEN_PERMISSIONS.some((p) => p.startsWith("auth:"))).toBe(false);
  });

  it("lets a token read and write files and read git, but never hold a terminal permission", () => {
    expect(TOKEN_PERMISSIONS).toContain("files:read");
    expect(TOKEN_PERMISSIONS).toContain("files:operate");
    expect(TOKEN_PERMISSIONS).toContain("vcs:read");
    expect(TOKEN_PERMISSIONS.some((p) => p.startsWith("terminal:"))).toBe(false);
    expect(TokenPermission.safeParse("terminal:operate").success).toBe(false);
    expect(ALL_PERMISSIONS).toContain("terminal:operate");
  });

  it("fixes the value shape, the lifetimes and the cap", () => {
    expect(API_TOKEN_PATTERN.test(`pap_${"A".repeat(43)}`)).toBe(true);
    expect(API_TOKEN_PATTERN.test(`pap_${"A".repeat(44)}`)).toBe(false);
    expect(API_TOKEN_PATTERN.test(`pap_${"A".repeat(42)}+`)).toBe(false);
    expect(API_TOKEN_PATTERN.test(`pap_${"A".repeat(43)}\n`)).toBe(false);
    expect(TOKEN_LIFETIMES_DAYS).toEqual([7, 30, 90, 365]);
    expect(MAX_TOKENS_PER_USER).toBe(50);
  });

  it("declares the three methods with their permissions, and the secret on create only", () => {
    expect(methods["auth.tokens.list"]).toMatchObject({ permission: "auth:read", idempotent: true });
    expect(methods["auth.tokens.create"]).toMatchObject({
      permission: "auth:admin",
      idempotent: false,
      secretResult: true,
    });
    expect(methods["auth.tokens.revoke"]).toMatchObject({ permission: "auth:admin", idempotent: false });
    expect("secretResult" in methods["auth.tokens.revoke"]).toBe(false);
    expect("secretResult" in methods["auth.tokens.list"]).toBe(false);
  });
});

describe("device contract", () => {
  it("declares the list as a read and both mutations as auth:admin without a secret or a step-up error", () => {
    expect(methods["auth.devices.list"]).toMatchObject({ permission: "auth:read", idempotent: true });
    for (const name of ["auth.devices.revoke", "auth.devices.revokeOthers"] as const) {
      expect(methods[name]).toMatchObject({ permission: "auth:admin", idempotent: false });
      expect("secretResult" in methods[name]).toBe(false);
      expect(methods[name].errors).not.toContain("step_up_required");
    }
    expect(methods["auth.devices.revoke"].errors).toEqual(["not_found"]);
  });

  it("shows families as codes and refuses an unknown one, a long address and a long id", () => {
    const view = {
      id: "a".repeat(32),
      current: true,
      browser: "chrome",
      os: "linux",
      ip: "10.0.0.1",
      method: "passkey",
      createdAt: 1,
      lastSeenAt: 2,
      expiresAt: 3,
    };
    const result = methods["auth.devices.list"].result;
    expect(result.safeParse({ devices: [view] }).success).toBe(true);
    expect(result.safeParse({ devices: [{ ...view, ip: null, method: null }] }).success).toBe(true);
    for (const bad of [
      { browser: "Chrome 130" },
      { os: "plan9" },
      { ip: "9".repeat(65) },
      { method: "cli" },
    ]) {
      expect(result.safeParse({ devices: [{ ...view, ...bad }] }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(result.safeParse({ devices: Array.from({ length: 201 }, () => view) }).success).toBe(false);
    expect(methods["auth.devices.revoke"].params.safeParse({ deviceId: "" }).success).toBe(false);
    expect(methods["auth.devices.revokeOthers"].result.safeParse({ revoked: -1 }).success).toBe(false);
  });
});

describe("passkey contract", () => {
  it("declares the list as a read and the removal as an auth:admin mutation that needs a step-up", () => {
    expect(methods["auth.passkeys.list"]).toMatchObject({ permission: "auth:read", idempotent: true });
    expect(methods["auth.passkeys.remove"]).toMatchObject({ permission: "auth:admin", idempotent: false });
    expect(methods["auth.passkeys.remove"].errors).toEqual(["step_up_required", "not_found"]);
    expect("secretResult" in methods["auth.passkeys.remove"]).toBe(false);
  });

  it("shows a passkey by its short id, never a credential id, and bounds every field", () => {
    const view = { id: "a".repeat(32), createdAt: 1, lastUsedAt: null, transports: ["usb"] };
    const result = methods["auth.passkeys.list"].result;
    expect(result.safeParse({ passkeys: [view] }).success).toBe(true);
    expect(result.safeParse({ passkeys: [{ ...view, lastUsedAt: 2 }] }).success).toBe(true);
    for (const bad of [
      { id: "" },
      { id: "a".repeat(129) },
      { lastUsedAt: undefined },
      { transports: "usb" },
    ]) {
      expect(result.safeParse({ passkeys: [{ ...view, ...bad }] }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(result.safeParse({ passkeys: Array.from({ length: 101 }, () => view) }).success).toBe(false);
    expect(methods["auth.passkeys.remove"].params.safeParse({ passkeyId: "" }).success).toBe(false);
    expect(methods["auth.passkeys.remove"].result.safeParse({ revoked: -1 }).success).toBe(false);
    expect(methods["auth.passkeys.remove"].result.safeParse({ revoked: 0 }).success).toBe(true);
  });
});
