import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, DOMAINS } from "./index.ts";

describe("domains", () => {
  it("has the pi domain after the M8 domains and the lanes domain right after it, with three levels each", () => {
    expect(DOMAINS.indexOf("lanes")).toBe(DOMAINS.indexOf("pi") + 1);
    expect(ALL_PERMISSIONS).toEqual(expect.arrayContaining(["lanes:read", "lanes:operate", "lanes:admin"]));
    expect(DOMAINS.indexOf("pi")).toBe(DOMAINS.indexOf("terminal") + 1);
    expect(ALL_PERMISSIONS).toEqual(expect.arrayContaining(["pi:read", "pi:operate", "pi:admin"]));
  });

  it("appends automation, usage and inbox after pi, each with its three levels (M10R1)", () => {
    expect(DOMAINS.slice(DOMAINS.indexOf("pi"))).toEqual(
      expect.arrayContaining(["pi", "automation", "usage", "inbox"]),
    );
    expect(DOMAINS.indexOf("automation")).toBeGreaterThan(DOMAINS.indexOf("pi"));
    expect(ALL_PERMISSIONS).toEqual(
      expect.arrayContaining(["automation:admin", "usage:operate", "inbox:read"]),
    );
  });
});
