import { describe, expect, it } from "vitest";
import { subagentsEn, subagentsFr } from "./subagents.ts";

const slots = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe("the subagents catalog", () => {
  it("has every key in both languages, filled, with the same slots", () => {
    expect(Object.keys(subagentsFr)).toEqual(Object.keys(subagentsEn));
    for (const key of Object.keys(subagentsEn) as Array<keyof typeof subagentsEn>) {
      expect(subagentsFr[key], key).not.toBe("");
      expect(slots(subagentsFr[key]), key).toEqual(slots(subagentsEn[key]));
    }
  });

  it("has a state label for each of the six states", () => {
    for (const state of ["starting", "running", "done", "failed", "cancelled", "interrupted"])
      expect(Object.keys(subagentsEn)).toContain(`subagents.state.${state}`);
  });
});
