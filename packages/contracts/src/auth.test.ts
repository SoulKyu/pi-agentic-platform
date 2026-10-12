import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  API_TOKEN_PATTERN,
  MAX_TOKENS_PER_USER,
  methods,
  TOKEN_LIFETIMES_DAYS,
  TOKEN_PERMISSIONS,
} from "./index.ts";

describe("token contract", () => {
  it("lets a token hold every permission except auth:* and policy:admin, in catalogue order", () => {
    expect(TOKEN_PERMISSIONS).toHaveLength(14);
    expect(TOKEN_PERMISSIONS).toEqual(
      ALL_PERMISSIONS.filter((p) => !p.startsWith("auth:") && p !== "policy:admin"),
    );
    expect(TOKEN_PERMISSIONS).not.toContain("policy:admin");
    expect(TOKEN_PERMISSIONS.some((p) => p.startsWith("auth:"))).toBe(false);
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
