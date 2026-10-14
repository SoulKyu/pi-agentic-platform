import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, DOMAINS } from "./index.ts";

describe("domains", () => {
  it("has the pi domain last, after the M8 domains, with its three levels", () => {
    expect(DOMAINS.at(-1)).toBe("pi");
    expect(DOMAINS.indexOf("pi")).toBe(DOMAINS.indexOf("terminal") + 1);
    expect(ALL_PERMISSIONS).toEqual(expect.arrayContaining(["pi:read", "pi:operate", "pi:admin"]));
  });
});
