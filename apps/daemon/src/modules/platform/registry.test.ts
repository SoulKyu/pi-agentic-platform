import { describe, expect, it } from "vitest";
import { createRegistry, PlatformRefusal } from "./registry.ts";

const handler = (() => Promise.resolve({})) as never;

describe("the platform registry", () => {
  it("offers no op until a handler is registered for it", () => {
    const registry = createRegistry();
    expect(registry.available("lane.note", "u1")).toBe(false);
    expect(registry.get("lane.note")).toBeNull();
    registry.register("lane.note", handler);
    expect(registry.available("lane.note", "u1")).toBe(true);
    expect(registry.available("subagent.run", "u1")).toBe(false);
  });

  it("asks the switch of an op for each owner", () => {
    const registry = createRegistry();
    registry.register("subagent.run", handler, { enabled: (ownerId) => ownerId === "u1" });
    expect(registry.available("subagent.run", "u1")).toBe(true);
    expect(registry.available("subagent.run", "u2")).toBe(false);
  });

  it("reads a switch that throws as off", () => {
    const registry = createRegistry();
    registry.register("subagent.run", handler, {
      enabled: () => {
        throw new Error("settings unreadable");
      },
    });
    expect(registry.available("subagent.run", "u1")).toBe(false);
  });

  it("refuses a second handler for the same op", () => {
    const registry = createRegistry();
    registry.register("agent.notify", handler);
    expect(() => registry.register("agent.notify", handler)).toThrow("already registered");
  });

  it("carries the code of a refusal", () => {
    const refusal = new PlatformRefusal("limit_reached");
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.code).toBe("limit_reached");
  });
});
