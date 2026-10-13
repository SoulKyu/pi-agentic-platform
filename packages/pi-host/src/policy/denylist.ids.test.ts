import { BUILTIN_DENY_IDS } from "@pap/contracts";
import { expect, it } from "vitest";
import { BUILTIN_CHECKS, FORK_BOMB_ID } from "./denylist.ts";

it("lists in contracts exactly the ids of the built-in checks, so Settings describes what pap blocks", () => {
  expect(new Set([...BUILTIN_CHECKS.map((check) => check.id), FORK_BOMB_ID])).toEqual(
    new Set(BUILTIN_DENY_IDS),
  );
});
