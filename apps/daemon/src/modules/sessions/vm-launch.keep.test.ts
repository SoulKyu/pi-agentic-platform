import { describe, expect, it } from "vitest";
import { codeOf } from "./testing/helpers.ts";
import { keepKeyOf } from "./vm-launch.ts";
import { hostInit, launch, row, setup, TASK, useVmLaunchHome } from "./vm-launch-fixtures.ts";

useVmLaunchHome();

const KEEP = "d".repeat(32);
const policy = { mode: "supervised", tools: ["read"], preset: "read-only", tainted: true } as const;

describe("the VM spec's keep key (K2)", () => {
  it("is put on the spec of a task row whose policy has the key", async () => {
    const bed = setup();
    const r = bed.use(row({ id: TASK, agentRole: "task", task: { ...policy, keepKey: KEEP } }));
    await bed.vmLaunch.spawn(r, launch({ role: "task" }), hostInit(r));
    expect(bed.specs[0]).toMatchObject({ kind: "isolated", keepKey: KEEP });
  });

  it("is put on the spec of a relaunched task row that carries the derived key (I2)", async () => {
    const bed = setup();
    const r = bed.use(row({ id: TASK, agentRole: "task", keptKey: KEEP }));
    await bed.vmLaunch.spawn(r, launch({ role: "task" }), hostInit(r));
    expect(bed.specs[0]).toMatchObject({ kind: "isolated", keepKey: KEEP });
  });

  it("is absent for a plain task, a thread row and a thread row that carries the key", async () => {
    for (const r of [
      row({ id: TASK, agentRole: "task", task: policy }),
      row({ agentRole: "thread" }),
      row({ agentRole: "thread", task: { ...policy, keepKey: KEEP } }),
    ]) {
      const bed = setup();
      bed.use(r);
      await bed.vmLaunch.spawn(r, launch({ role: r.agentRole as "task" | "thread" }), hostInit(r));
      expect(bed.specs[0]).not.toHaveProperty("keepKey");
    }
  });

  it("refuses a key that is not a task key", async () => {
    const bed = setup();
    const r = bed.use(row({ id: TASK, agentRole: "task", task: { ...policy, keepKey: "not-a-key" } }));
    expect(await codeOf(bed.vmLaunch.spawn(r, launch({ role: "task" }), hostInit(r)))).toBe("bad_request");
  });
});

describe("keepKeyOf (K2)", () => {
  it("is the policy's key for a task row, and null for every other row", () => {
    expect(keepKeyOf(row({ agentRole: "task", task: { ...policy, keepKey: KEEP } }))).toBe(KEEP);
    expect(keepKeyOf(row({ agentRole: "task", task: policy }))).toBeNull();
    expect(keepKeyOf(row({ agentRole: "task", keptKey: KEEP }))).toBe(KEEP);
    expect(keepKeyOf(row({ agentRole: "thread", keptKey: KEEP }))).toBeNull();
    expect(keepKeyOf(row({ agentRole: "thread", task: { ...policy, keepKey: KEEP } }))).toBeNull();
    expect(keepKeyOf(row({ agentRole: "child", task: { ...policy, keepKey: KEEP } }))).toBeNull();
  });
});
