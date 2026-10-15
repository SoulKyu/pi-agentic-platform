import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, DOMAINS } from "./index.ts";

describe("domains", () => {
  it("has the pi domain after the M8 domains and the lanes domain right after it, with three levels each", () => {
    expect(DOMAINS.indexOf("lanes")).toBe(DOMAINS.indexOf("pi") + 1);
    expect(ALL_PERMISSIONS).toEqual(expect.arrayContaining(["lanes:read", "lanes:operate", "lanes:admin"]));
    expect(DOMAINS.indexOf("pi")).toBe(DOMAINS.indexOf("terminal") + 1);
    expect(ALL_PERMISSIONS).toEqual(expect.arrayContaining(["pi:read", "pi:operate", "pi:admin"]));
  });
});
