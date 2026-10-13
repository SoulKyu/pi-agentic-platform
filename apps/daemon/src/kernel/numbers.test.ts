import { expect, it } from "vitest";
import { isCount } from "./numbers.ts";

it("accepts non-negative safe integers only", () => {
  expect([0, 3, Number.MAX_SAFE_INTEGER].map(isCount)).toEqual([true, true, true]);
  expect([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "3", null].map(isCount)).toEqual([
    false,
    false,
    false,
    false,
    false,
    false,
    false,
  ]);
});
