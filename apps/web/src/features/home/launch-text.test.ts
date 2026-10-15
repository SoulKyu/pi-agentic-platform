import { AUTOMATION_LIMITS, LANE_LIMITS, LaneTitle, TriggerName } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { clipTitle, laneLaunch, splitLaunchText, triggerLaunch } from "./launch-text.ts";

describe("splitLaunchText", () => {
  it("takes the first line that shows something, cleaned, and the trimmed lines after it", () => {
    expect(splitLaunchText("Fix the login\nSteps:\n1. open")).toEqual({
      first: "Fix the login",
      rest: "Steps:\n1. open",
    });
    expect(splitLaunchText("\n \n  Fix the login  \r\nwhy\r\n")).toEqual({
      first: "Fix the login",
      rest: "why",
    });
    expect(splitLaunchText("\u200b\u202e\nReal title\nbody")).toEqual({ first: "Real title", rest: "body" });
    expect(splitLaunchText("Fix\u202e the\u200b login\tnow")).toEqual({
      first: "Fix the login now",
      rest: "",
    });
    expect(splitLaunchText("Fix\rthe login\u2028why\u2029more")).toEqual({
      first: "Fix",
      rest: "the login\nwhy\nmore",
    });
    expect(splitLaunchText("   \n\t")).toEqual({ first: "", rest: "" });
  });
});

describe("clipTitle", () => {
  it("keeps to both bounds and never cuts a surrogate pair", () => {
    expect(clipTitle("😀".repeat(150), 200, 200)).toBe("😀".repeat(100));
    expect(clipTitle("😀".repeat(100), 80, 320)).toBe("😀".repeat(80));
    expect(clipTitle("ab😀", 10, 3)).toBe("ab");
    expect(clipTitle("abc def", 4, 10)).toBe("abc");
  });
});

describe("laneLaunch (§3.1 Lane and Fan-out)", () => {
  it("makes the first line the title and the lines after it the description", () => {
    expect(laneLaunch("Replace the cache\nKeep the API", "/w/api", false)).toEqual({
      projectRoot: "/w/api",
      title: "Replace the cache",
      text: "Keep the API",
      models: [null],
    });
  });

  it("keeps the whole text as the description when there is one line: a lane needs one", () => {
    expect(laneLaunch("  Replace the cache  ", "/w/api", false)).toMatchObject({
      title: "Replace the cache",
      text: "Replace the cache",
    });
  });

  it("keeps the whole first line when it is clipped: the title holds the head, the description the full line then the rest", () => {
    const long = "x".repeat(300);
    const launch = laneLaunch(`${long}\nbody`, "/w", false);
    expect(launch.title).toBe("x".repeat(LANE_LIMITS.title));
    expect(launch.text).toBe(`${long}\nbody`);
    expect(laneLaunch(`${long}`, "/w", false).text).toBe(long);
  });

  it("presets two model slots for a fan-out, an empty one too", () => {
    expect(laneLaunch("", "/w/api", true)).toEqual({
      projectRoot: "/w/api",
      title: "",
      text: "",
      models: [null, null],
    });
  });

  it("hands the dialog a title its schema accepts, whatever the first line holds (Review Focus 2)", () => {
    for (const text of [
      "😀".repeat(150),
      `${"x".repeat(500)}\nbody`,
      "\u202e\u200bFix\u0007 it\nbody",
      "\r\n\r\nFix\r\nbody",
    ]) {
      const title = laneLaunch(text, "/w", false).title ?? "";
      expect(LaneTitle.safeParse(title).success, JSON.stringify(text)).toBe(true);
      expect([...title].length).toBeLessThanOrEqual(LANE_LIMITS.title);
    }
  });
});

describe("triggerLaunch (§3.1 Trigger)", () => {
  it("names the trigger after the first line and keeps the whole text as the prompt", () => {
    expect(triggerLaunch("Nightly report\nSummarise the failures")).toEqual({
      name: "Nightly report",
      prompt: "Nightly report\nSummarise the failures",
    });
    expect(triggerLaunch("  ")).toEqual({ name: "", prompt: "" });
  });

  it("hands the editor a name its schema accepts (Review Focus 2)", () => {
    for (const text of ["😀".repeat(100), "\u202eName\u200b\nx", "y".repeat(500)]) {
      const { name } = triggerLaunch(text);
      expect(TriggerName.safeParse(name).success, JSON.stringify(text)).toBe(true);
      expect([...name].length).toBeLessThanOrEqual(AUTOMATION_LIMITS.nameChars);
    }
  });
});
