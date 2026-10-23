import { describe, expect, it } from "vitest";
import { createLaunchTaint } from "./launch-taint.ts";

describe("the launch taint", () => {
  it("answers the joined sessions once, then nothing", () => {
    const taint = createLaunchTaint();
    taint.join("l1", "s1");
    taint.join("l1", "s2");
    expect(taint.mark("l1")).toEqual(["s1", "s2"]);
    expect(taint.mark("l1")).toEqual([]);
  });

  it("tells a session that joins a marked launch to start tainted", () => {
    const taint = createLaunchTaint();
    expect(taint.join("l1", "s1")).toBe(false);
    taint.mark("l1");
    expect(taint.join("l1", "s2")).toBe(true);
  });

  it("keeps launches apart and forgets an ended one", () => {
    const taint = createLaunchTaint();
    taint.join("l1", "s1");
    taint.mark("l1");
    expect(taint.join("l2", "s2")).toBe(false);
    taint.ended("l1");
    expect(taint.join("l1", "s3")).toBe(false);
    expect(taint.mark("l1")).toEqual(["s3"]);
  });
});
