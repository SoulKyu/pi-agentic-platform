import { describe, expect, it } from "vitest";
import { blockedAddress } from "./address.ts";
import { blockedStrict } from "./address-strict.ts";
import { ADDED, NEVER_DIALLED, SHARED } from "./address-vectors.ts";

describe("blockedStrict", () => {
  it.each(ADDED)(
    "refuses %s, which the proxy's check lets through where it is a range of this task",
    (ip) => {
      expect(blockedStrict(ip)).toBe(true);
    },
  );

  it("is stricter than blockedAddress on the ranges it adds", () => {
    const loosened = ADDED.filter((ip) => !blockedAddress(ip));
    expect(loosened.length).toBeGreaterThan(10);
  });

  it("agrees with blockedAddress everywhere else", () => {
    expect(SHARED).toHaveLength(20);
    for (const ip of SHARED) expect([ip, blockedStrict(ip)]).toEqual([ip, blockedAddress(ip)]);
  });
});

describe("the default check of the push sender", () => {
  it.each(NEVER_DIALLED)("refuses %s", (ip) => {
    expect(blockedStrict(ip)).toBe(true);
  });
});
