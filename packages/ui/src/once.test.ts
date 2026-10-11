import { describe, expect, it, vi } from "vitest";
import { once } from "./once.ts";

describe("once", () => {
  it("runs the callback for the first call only", () => {
    const spy = vi.fn();
    const answer = once(spy);
    expect(answer(true)).toBe(true);
    expect(answer(false)).toBe(false);
    expect(spy).toHaveBeenCalledExactlyOnceWith(true);
  });
});
