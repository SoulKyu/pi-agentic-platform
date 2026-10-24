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
    expect(taint.join("l1", "s1")).toEqual([]);
    taint.mark("l1");
    expect(taint.join("l1", "s2")).toEqual(["s2"]);
  });

  it("keeps launches apart and forgets an ended one", () => {
    const taint = createLaunchTaint();
    taint.join("l1", "s1");
    taint.mark("l1");
    expect(taint.join("l2", "s2")).toEqual([]);
    taint.ended("l1");
    expect(taint.join("l1", "s3")).toEqual([]);
    expect(taint.mark("l1")).toEqual(["s3"]);
  });

  it("marks the launch when a session joins tainted, and when a joined one is raised", () => {
    const taint = createLaunchTaint();
    taint.join("l1", "s1");
    expect(taint.join("l1", "s2", true)).toEqual(["s1", "s2"]);
    expect(taint.join("l1", "s3")).toEqual(["s3"]);
    taint.join("l2", "t1");
    taint.join("l2", "t2");
    expect(taint.raised("t2")).toEqual(["t1", "t2"]);
    expect(taint.raised("t1")).toEqual([]);
    expect(taint.raised("nobody")).toEqual([]);
    taint.ended("l2");
    expect(taint.raised("t1")).toEqual([]);
  });
});
