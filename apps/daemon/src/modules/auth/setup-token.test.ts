import { describe, expect, it } from "vitest";
import { createSetupToken } from "./setup-token.ts";

describe("setup token", () => {
  it("is random per instance and only the exact value verifies", () => {
    const first = createSetupToken(true);
    const second = createSetupToken(true);
    const token = first.current() ?? "";
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(token).not.toBe(second.current());
    expect(first.verify(token)).toBe(true);
    expect(first.verify(`${token}x`)).toBe(false);
    expect(first.verify(token.slice(1))).toBe(false);
    expect(first.verify("")).toBe(false);
    expect(first.verify(second.current() ?? "")).toBe(false);
    expect(first.verify("x".repeat(300))).toBe(false);
  });

  it("is invalid for good once consumed, and never exists when setup is not needed", () => {
    const token = createSetupToken(true);
    const value = token.current() ?? "";
    token.consume();
    expect(token.current()).toBeNull();
    expect(token.verify(value)).toBe(false);
    const inactive = createSetupToken(false);
    expect(inactive.current()).toBeNull();
    expect(inactive.verify("")).toBe(false);
    expect(inactive.verify("anything")).toBe(false);
  });
});
