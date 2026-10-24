import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_BOX,
  createFixture,
  PROJECT,
  seedDisk,
  startRequest,
  TASK,
  type Fixture,
} from "./testing/ops-fixture.ts";
import type { ExecHandler } from "./testing/fake-exec.ts";

/*
 * Mutants killed here, run for real:
 *  - M-reclaim-while-held: `vm.stop` digs holes although `rm --force` failed: killed by "never when the container could not be removed".
 *  - M-reclaim-listed-running: it digs although `nerdctl ps` still lists the box's VM: killed by "never while the VM is still listed".
 *  - M-reclaim-task-disk: it digs a task's disk: killed by "a task's disk is deleted, not reclaimed".
 */
const isDig = (argv: readonly string[]): boolean => argv.includes("--dig-holes");
const isRm = (argv: readonly string[]): boolean => argv.includes("rm");

let fx: Fixture;
const use = (handler?: ExecHandler): void => {
  if ((fx as Fixture | undefined) !== undefined) fx.cleanup();
  fx = createFixture(handler);
};
afterEach(() => fx.cleanup());

describe("vm.stop reclaims the box disk", () => {
  it("digs holes once the VM is gone and logs the bytes before and after", async () => {
    use();
    const disk = seedDisk(fx);
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: null });
    const digs = fx.exec.calls.filter(isDig);
    expect(digs).toEqual([["/usr/bin/fallocate", "--dig-holes", disk]]);
    expect(fx.exec.timeouts[fx.exec.calls.findIndex(isDig)]).toBeGreaterThan(0);
    const event = fx.logs.find((entry) => entry.event === "vmd_disk_reclaimed");
    expect(event?.fields).toMatchObject({ before: expect.any(Number), after: expect.any(Number) });
  });

  it("reclaims a project box's disk too", async () => {
    use();
    const disk = seedDisk(fx, PROJECT);
    await fx.ops.handle({ op: "vm.stop", box: PROJECT, taskKey: null });
    expect(fx.exec.calls.filter(isDig)).toEqual([["/usr/bin/fallocate", "--dig-holes", disk]]);
  });

  it("never when the container could not be removed (it may still hold the disk)", async () => {
    use((argv) => (isRm(argv) ? { code: 1, stderr: "containerd: connection refused" } : undefined));
    seedDisk(fx);
    await expect(fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: null })).rejects.toMatchObject({
      code: "failed",
    });
    expect(fx.exec.calls.filter(isDig)).toEqual([]);
  });

  it("never while the VM is still listed as running", async () => {
    use();
    seedDisk(fx);
    fx.ps = ["pap-helper-1a2b Up 3 seconds"];
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: null });
    expect(fx.exec.calls.filter(isDig)).toEqual([]);
  });

  it("never when the VM list cannot be read (fails closed)", async () => {
    use();
    seedDisk(fx);
    fx.psCode = 1;
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: null });
    expect(fx.exec.calls.filter(isDig)).toEqual([]);
  });

  it("a task's disk is deleted, not reclaimed", async () => {
    use();
    await fx.ops.handle(startRequest({ kind: "isolated", taskKey: TASK }));
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: TASK });
    expect(fx.exec.calls.filter(isDig)).toEqual([]);
  });

  it("a box without a disk file is left alone", async () => {
    use();
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: null });
    expect(fx.exec.calls.filter(isDig)).toEqual([]);
    expect(fx.logs.some((entry) => entry.event === "vmd_disk_reclaim_failed")).toBe(false);
  });

  it("a failing fallocate is logged with a fixed word and the stop still succeeds", async () => {
    use((argv) => (isDig(argv) ? { code: 1, stderr: "secret detail" } : undefined));
    seedDisk(fx);
    await expect(fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: null })).resolves.toEqual({
      stopped: true,
    });
    const failed = fx.logs.find((entry) => entry.event === "vmd_disk_reclaim_failed");
    expect(failed?.fields).toEqual({ reason: "exec" });
  });

  it("a timeout is logged and the stop still succeeds", async () => {
    use((argv) => (isDig(argv) ? { code: -1 } : undefined));
    seedDisk(fx);
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: null });
    expect(fx.logs.find((entry) => entry.event === "vmd_disk_reclaim_failed")?.fields).toEqual({
      reason: "timeout_or_spawn",
    });
  });
});
