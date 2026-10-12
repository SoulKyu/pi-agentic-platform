import { describe, expect, it } from "vitest";
import { createTrail } from "./trail.ts";

describe("the trail", () => {
  it("keeps the verdicts it is given", () => {
    const trail = createTrail();
    trail.add("01", "skip", "not in force");
    trail.add("02", "pass");
    expect(trail.list()).toEqual([
      { stage: "01", outcome: "skip", reason: "not in force" },
      { stage: "02", outcome: "pass" },
    ]);
  });

  it("skips every stage from the given one to 04 that has no verdict yet", () => {
    const trail = createTrail();
    trail.add("01", "pass");
    trail.add("03", "block", "category blocked");
    trail.skipFrom("02", "x");
    expect(trail.list()).toEqual([
      { stage: "01", outcome: "pass" },
      { stage: "02", outcome: "skip", reason: "x" },
      { stage: "03", outcome: "block", reason: "category blocked" },
      { stage: "04", outcome: "skip", reason: "x" },
    ]);
  });

  it("cuts a reason to 256 characters, never inside a surrogate pair", () => {
    const trail = createTrail();
    trail.add("01", "block", "a".repeat(300));
    trail.add("02", "block", `${"a".repeat(255)}😀`);
    trail.add("03", "block", "😀".repeat(200));
    const [one, two, three] = trail.list();
    expect(one?.reason).toBe("a".repeat(256));
    expect(two?.reason).toBe("a".repeat(255));
    expect(three?.reason?.length).toBe(256);
    expect(three?.reason).toBe("😀".repeat(128));
  });

  it("refuses a stage added twice", () => {
    const trail = createTrail();
    trail.add("03", "allow");
    expect(() => trail.add("03", "block")).toThrow(RangeError);
  });

  it("lists the verdicts sorted by stage id", () => {
    const trail = createTrail();
    trail.add("04", "pass");
    trail.add("01", "skip");
    trail.add("03", "allow");
    expect(trail.list().map((verdict) => verdict.stage)).toEqual(["01", "03", "04"]);
  });
});
