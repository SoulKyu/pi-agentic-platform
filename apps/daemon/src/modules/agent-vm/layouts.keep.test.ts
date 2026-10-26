import { describe, expect, it } from "vitest";
import { layoutOfSpec } from "./layouts.ts";

const BOX = { kind: "agent", id: "a-1" } as const;
const KEEP = "d".repeat(32);

describe("layoutOfSpec for a kept task (K2)", () => {
  it("roots the process folder at the keep key, so the next run finds it", () => {
    expect(layoutOfSpec("process", "/p", { box: BOX, taskKey: "t1", keepKey: KEEP }).root).toBe(
      `/p/tmp/agent-vm/a-1-${KEEP}`,
    );
  });
  it("keeps the task key for a plain task, and Kata's /agent for every VM", () => {
    expect(layoutOfSpec("process", "/p", { box: BOX, taskKey: "t1" }).root).toBe("/p/tmp/agent-vm/a-1-t1");
    expect(layoutOfSpec("process", "/p", { box: BOX, taskKey: "t1", keepKey: null }).root).toBe(
      "/p/tmp/agent-vm/a-1-t1",
    );
    expect(layoutOfSpec("kata", "/p", { box: BOX, taskKey: "t1", keepKey: KEEP }).root).toBe("/agent");
  });
});
