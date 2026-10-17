import { describe, expect, it } from "vitest";
import { compareVersions } from "./version.ts";

const PAIRS: ReadonlyArray<readonly [string, string, -1 | 0 | 1]> = [
  ["1.0.0", "1.0.0", 0],
  ["1.0.0", "1.0.0-next.3", 1],
  ["1.0.0-next.3", "1.0.0", -1],
  ["1.2.0-next.10", "1.2.0-next.9", 1],
  ["1.2.0-next.9", "1.2.0-next.10", -1],
  ["1.10.0", "1.9.0", 1],
  ["1.9.0", "1.10.0", -1],
  ["2.0.0", "1.99.99", 1],
  ["1.0.10", "1.0.9", 1],
  ["1.3.0-next.12", "1.2.9", 1],
  ["1.3.0-next.1", "1.3.0-next.1", 0],
  ["0.0.0", "0.0.1", -1],
  ["0.0.0", "1.0.0-next.1", -1],
  ["0.0.0", "0.0.0", 0],
  ["1.0.0-alpha", "1.0.0-alpha.1", -1],
  ["1.0.0-alpha.1", "1.0.0-alpha.beta", -1],
  ["1.0.0-alpha.beta", "1.0.0-beta", -1],
  ["1.0.0-1", "1.0.0-alpha", -1],
  ["1.0.0-rc.1", "1.0.0-next.99", 1],
  ["99999999999999999999.0.0", "99999999999999999998.0.0", 1],
];

describe("compareVersions", () => {
  it.each(PAIRS)("%s vs %s is %i", (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });

  it("is antisymmetric on the table", () => {
    for (const [a, b, expected] of PAIRS) expect(compareVersions(b, a)).toBe(expected === 0 ? 0 : -expected);
  });

  it("refuses a string that is not a version", () => {
    expect(() => compareVersions("1.0", "1.0.0")).toThrow("not a version");
    expect(() => compareVersions("1.0.0", "v1.0.0")).toThrow("not a version");
  });
});
