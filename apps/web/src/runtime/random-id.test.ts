import { describe, expect, it } from "vitest";
import { randomId } from "./random-id.ts";

describe("randomId", () => {
  it("returns lowercase hex of twice the byte count, and differs between calls", () => {
    expect(randomId()).toMatch(/^[0-9a-f]{32}$/);
    expect(randomId(4)).toMatch(/^[0-9a-f]{8}$/);
    expect(randomId()).not.toBe(randomId());
  });
});
