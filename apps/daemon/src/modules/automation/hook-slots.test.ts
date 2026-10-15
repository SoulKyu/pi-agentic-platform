import { describe, expect, it } from "vitest";
import { createHookSlots } from "./hook-slots.ts";

describe("hook slots", () => {
  it("gives a trigger 2 unauthenticated slots and the pool 8", () => {
    const slots = createHookSlots();
    expect(slots.take("unauthenticated", "a")).not.toBeNull();
    expect(slots.take("unauthenticated", "a")).not.toBeNull();
    expect(slots.take("unauthenticated", "a")).toBeNull();
    for (const id of ["b", "c", "d"]) {
      expect(slots.take("unauthenticated", id)).not.toBeNull();
      expect(slots.take("unauthenticated", id)).not.toBeNull();
    }
    expect(slots.inUse("unauthenticated")).toBe(8);
    expect(slots.take("unauthenticated", "e")).toBeNull();
  });
  it("never starves an authenticated read with eight unauthenticated ones", () => {
    const slots = createHookSlots();
    for (const id of ["a", "b", "c", "d"]) {
      slots.take("unauthenticated", id);
      slots.take("unauthenticated", id);
    }
    expect(slots.take("authenticated", "z")).not.toBeNull();
  });
  it("gives the authenticated pool 4, 2 per trigger", () => {
    const slots = createHookSlots();
    expect(slots.take("authenticated", "a")).not.toBeNull();
    expect(slots.take("authenticated", "a")).not.toBeNull();
    expect(slots.take("authenticated", "a")).toBeNull();
    expect(slots.take("authenticated", "b")).not.toBeNull();
    expect(slots.take("authenticated", "b")).not.toBeNull();
    expect(slots.take("authenticated", "c")).toBeNull();
    expect(slots.inUse("authenticated")).toBe(4);
  });
  it("releases once, however many times it is called", () => {
    const slots = createHookSlots();
    const release = slots.take("authenticated", "a");
    slots.take("authenticated", "a");
    release?.();
    release?.();
    release?.();
    expect(slots.inUse("authenticated")).toBe(1);
    expect(slots.take("authenticated", "a")).not.toBeNull();
  });
});
