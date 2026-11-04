import { AgentInput } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { onlyAlwaysOnChanged } from "./always-on-edit.ts";

const a = AgentInput.parse({ name: "Atlas" });

describe("onlyAlwaysOnChanged", () => {
  it("is true when alwaysOn is the only difference", () => {
    expect(onlyAlwaysOnChanged(a, { ...a, alwaysOn: true })).toBe(true);
  });
  it("is false when another field changed too", () => {
    expect(onlyAlwaysOnChanged(a, { ...a, alwaysOn: true, thinking: "high" })).toBe(false);
  });
  it("is false when either side is null", () => {
    expect(onlyAlwaysOnChanged(null, a)).toBe(false);
    expect(onlyAlwaysOnChanged(a, null)).toBe(false);
  });
  it("is false when nothing changed", () => {
    expect(onlyAlwaysOnChanged(a, { ...a })).toBe(false);
  });
});
