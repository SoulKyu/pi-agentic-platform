import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sparseCopyArgv } from "./argv.ts";
import { procHoldsFile, reclaimDisk } from "./ops-reclaim.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const isDig = (argv: readonly string[]): boolean => argv[0] === "/usr/bin/cp";
/** What a good `cp --sparse=always` leaves: the copy beside the disk. */
const copies: ExecHandler = (argv) => {
  if (isDig(argv)) copyFileSync(argv.at(-2) as string, argv.at(-1) as string);
  return undefined;
};
const isRm = (argv: readonly string[]): boolean => argv.includes("rm");

let fx: Fixture;
const use = (handler?: ExecHandler): void => {
  if ((fx as Fixture | undefined) !== undefined) fx.cleanup();
  fx = createFixture(handler);
};
afterEach(() => fx.cleanup());

describe("vm.stop reclaims the box disk", () => {
  it("copies the disk sparsely once the VM is gone, renames it over the disk and logs the bytes", async () => {
    use(copies);
    const disk = seedDisk(fx);
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: null });
    await fx.ops.idle();
    const digs = fx.exec.calls.filter(isDig);
    expect(digs).toEqual([sparseCopyArgv(disk, `${disk}.reclaim`)]);
    expect(existsSync(`${disk}.reclaim`)).toBe(false);
    expect(readFileSync(disk, "utf8")).toBe("agent disk");
    expect(fx.exec.timeouts[fx.exec.calls.findIndex(isDig)]).toBeGreaterThan(0);
    const event = fx.logs.find((entry) => entry.event === "vmd_disk_reclaimed");
    expect(event?.fields).toMatchObject({ before: expect.any(Number), after: expect.any(Number) });
  });

  it("reclaims a project box's disk too", async () => {
    use(copies);
    const disk = seedDisk(fx, PROJECT);
    await fx.ops.handle({ op: "vm.stop", box: PROJECT, taskKey: null });
    await fx.ops.idle();
    expect(fx.exec.calls.filter(isDig)).toEqual([sparseCopyArgv(disk, `${disk}.reclaim`)]);
  });

  it("never when the container could not be removed (it may still hold the disk)", async () => {
    use((argv) => (isRm(argv) ? { code: 1, stderr: "containerd: connection refused" } : undefined));
    seedDisk(fx);
    await expect(fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: null })).rejects.toMatchObject({
      code: "failed",
    });
    await fx.ops.idle();
    expect(fx.exec.calls.filter(isDig)).toEqual([]);
  });

  it("never while the VM is still listed as running", async () => {
    use();
    seedDisk(fx);
    fx.ps = ["pap-helper-1a2b Up 3 seconds"];
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: null });
    await fx.ops.idle();
    expect(fx.exec.calls.filter(isDig)).toEqual([]);
  });

  it("never when the VM list cannot be read (fails closed)", async () => {
    use();
    seedDisk(fx);
    fx.psCode = 1;
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: null });
    await fx.ops.idle();
    expect(fx.exec.calls.filter(isDig)).toEqual([]);
  });

  it("a task's disk is deleted, not reclaimed", async () => {
    use();
    await fx.ops.handle(startRequest({ kind: "isolated", taskKey: TASK }));
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: TASK });
    await fx.ops.idle();
    expect(fx.exec.calls.filter(isDig)).toEqual([]);
  });

  it("the stop answers before the dig finishes, and a start waits for the dig", async () => {
    let finish: () => void = () => undefined;
    const digging = new Promise<void>((resolve) => (finish = resolve));
    use(async (argv) => {
      if (isDig(argv)) await digging;
      return copies(argv);
    });
    seedDisk(fx);
    await expect(fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: null })).resolves.toEqual({
      stopped: true,
    });
    const events = (): string[] =>
      fx.exec.calls
        .filter((argv) => isDig(argv) || argv.includes("run"))
        .map((argv) => (isDig(argv) ? "dig" : "run"));
    await vi.waitFor(() => expect(events()).toEqual(["dig"]));
    const started = fx.ops.handle(startRequest());
    finish();
    await started;
    await fx.ops.idle();
    expect(events()).toEqual(["dig", "run"]);
  });

  it("skips the dig, with a fixed log word, while a process holds the file", async () => {
    use();
    fx.cleanup();
    fx = createFixture(undefined, { holdsFile: () => true });
    seedDisk(fx);
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: null });
    await fx.ops.idle();
    expect(fx.exec.calls.filter(isDig)).toEqual([]);
    expect(fx.logs.find((entry) => entry.event === "vmd_disk_reclaim_skipped")?.fields).toEqual({
      reason: "file_held",
    });
  });

  it("a box without a disk file is left alone", async () => {
    use();
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: null });
    await fx.ops.idle();
    expect(fx.exec.calls.filter(isDig)).toEqual([]);
    expect(fx.logs.some((entry) => entry.event === "vmd_disk_reclaim_failed")).toBe(false);
  });

  it("a failing copy is logged with a fixed word, removes the temp, keeps the disk and the stop still succeeds", async () => {
    use((argv) => {
      if (!isDig(argv)) return undefined;
      writeFileSync(argv.at(-1) as string, "partial");
      return { code: 1, stderr: "secret detail" };
    });
    const disk = seedDisk(fx);
    await expect(fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: null })).resolves.toEqual({
      stopped: true,
    });
    await fx.ops.idle();
    expect(fx.logs.find((entry) => entry.event === "vmd_disk_reclaim_failed")?.fields).toEqual({
      reason: "exec",
    });
    expect(existsSync(`${disk}.reclaim`)).toBe(false);
    expect(readFileSync(disk, "utf8")).toBe("agent disk");
  });

  it("a timeout is logged and leaves no temp", async () => {
    use((argv) => (isDig(argv) ? { code: -1 } : undefined));
    const disk = seedDisk(fx);
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: null });
    await fx.ops.idle();
    expect(fx.logs.find((entry) => entry.event === "vmd_disk_reclaim_failed")?.fields).toEqual({
      reason: "timeout_or_spawn",
    });
    expect(existsSync(`${disk}.reclaim`)).toBe(false);
  });

  it("a copy of another size is refused and removed; the disk stays", async () => {
    use((argv) => {
      if (isDig(argv)) writeFileSync(argv.at(-1) as string, "short");
      return undefined;
    });
    const disk = seedDisk(fx);
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: null });
    await fx.ops.idle();
    expect(fx.logs.find((entry) => entry.event === "vmd_disk_reclaim_failed")?.fields).toEqual({
      reason: "size_mismatch",
    });
    expect(existsSync(`${disk}.reclaim`)).toBe(false);
    expect(readFileSync(disk, "utf8")).toBe("agent disk");
  });

  it("removes a stale temp first, and skips with no_room when the folder lacks the space", async () => {
    use(copies);
    const disk = seedDisk(fx);
    writeFileSync(`${disk}.reclaim`, "stale");
    const reclaim = (freeBytes?: (folder: string) => number): Promise<void> =>
      reclaimDisk(
        fx.exec.exec,
        { info: (event, fields) => void fx.logs.push({ event, fields }) },
        disk,
        () => false,
        freeBytes,
      );
    await reclaim();
    expect(readFileSync(disk, "utf8")).toBe("agent disk");
    expect(existsSync(`${disk}.reclaim`)).toBe(false);
    fx.logs.length = 0;
    fx.exec.calls.length = 0;
    await reclaim(() => 4096);
    expect(fx.exec.calls.filter(isDig)).toEqual([]);
    expect(fx.logs.find((entry) => entry.event === "vmd_disk_reclaim_skipped")?.fields).toEqual({
      reason: "no_room",
    });
  });
});

describe("procHoldsFile", () => {
  it("sees a descriptor of this very process and nothing else", () => {
    const folder = mkdtempSync(path.join(tmpdir(), "pap-vmd-held-"));
    const file = path.join(folder, "disk.img");
    writeFileSync(file, "x");
    try {
      expect(procHoldsFile(file)).toBe(false);
      const fd = openSync(file, "r");
      try {
        expect(procHoldsFile(file)).toBe(true);
      } finally {
        closeSync(fd);
      }
      expect(procHoldsFile(path.join(folder, "missing"))).toBe(true);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
