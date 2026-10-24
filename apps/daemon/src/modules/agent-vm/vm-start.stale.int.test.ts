import { afterEach, describe, expect, it } from "vitest";
import type { SkewVerdict } from "./bundle-skew.ts";
import { startVmBed, type VmBed } from "../../testing/vm-bed.ts";

let bed: VmBed | undefined;
afterEach(async () => {
  await bed?.stop();
  bed = undefined;
});

describe("a VM start against a stale bundle", () => {
  it("starts no VM and fails the open with vm_bundle_stale", async () => {
    let verdict: SkewVerdict = "stale";
    const asked: string[] = [];
    bed = await startVmBed(
      { steps: [{ text: "hi" }] },
      { seams: { bundleSkew: { check: async (box) => (asked.push(box.id), verdict) } } },
    );
    const agentId = await bed.createAgent();
    await expect(bed.call("agents.openThread", { agentId })).rejects.toThrow("vm_bundle_stale");
    expect(asked).toEqual([agentId]);
    expect(bed.vms.started).toEqual([]);

    verdict = "ok";
    await expect(bed.openThread(agentId)).resolves.toEqual(expect.any(String));
    expect(bed.vms.started).toHaveLength(1);
  }, 120_000);
});
