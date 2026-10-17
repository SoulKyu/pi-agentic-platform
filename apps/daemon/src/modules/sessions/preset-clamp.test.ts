import type { ToolPreset } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { narrowPreset } from "./preset-clamp.ts";

describe("narrowPreset (W5-R28)", () => {
  it.each<[ToolPreset, ToolPreset, ToolPreset]>([
    // owner, profile, result: the strict order chat < none < read-only < default < full
    ["chat", "none", "chat"],
    ["none", "chat", "chat"],
    ["none", "none", "none"],
    ["read-only", "default", "read-only"],
    ["full", "default", "default"],
    ["default", "full", "default"],
    ["chat", "full", "chat"],
    ["none", "read-only", "none"],
    ["read-only", "none", "none"],
  ])("owner %s on profile %s gives %s", (owner, profile, result) => {
    expect(narrowPreset(owner, profile)).toBe(result);
  });

  it("an owner choice of configured ranks as full on a profile that is not configured", () => {
    expect(narrowPreset("configured", "full")).toBe("full");
    expect(narrowPreset("configured", "default")).toBe("default");
    expect(narrowPreset("configured", "chat")).toBe("chat");
  });

  it("a configured profile accepts configured, none and chat only", () => {
    expect(narrowPreset("configured", "configured")).toBe("configured");
    expect(narrowPreset("none", "configured")).toBe("none");
    expect(narrowPreset("chat", "configured")).toBe("chat");
    expect(narrowPreset("read-only", "configured")).toBe("configured");
    expect(narrowPreset("default", "configured")).toBe("configured");
    expect(narrowPreset("full", "configured")).toBe("configured");
  });
});
