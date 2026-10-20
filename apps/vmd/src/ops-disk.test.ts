import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VmdFailure } from "./errors.ts";
import type { ExecHandler } from "./testing/fake-exec.ts";
import {
  AGENT,
  createFixture,
  MIB,
  OTHER_AGENT,
  seedDisk,
  TASK,
  type Fixture,
} from "./testing/ops-fixture.ts";

/*
 * Mutants (RT-43) killed here, run for real:
 *  - M-grow-smaller: `disk.grow` truncates to the requested size whatever it is: killed by "disk.grow refuses a smaller size".
 *  - M-grow-running: no running-VM check in `disk.grow`: killed by "disk.grow is conflict while a VM of the agent runs".
 *  - M-grow-resizes: `e2fsck` or `resize2fs` runs after the truncate (R31): killed by "disk.grow only extends the file".
 *  - M-unknown-status-is-stopped (I1): a status nerdctl prints that pap does not know counts as stopped: killed by
 *    "an unknown, a pausing or an empty status blocks disk.grow and disk.delete".
 *  - M-delete-running: `disk.delete` of the agent's disk without the running check: killed by "disk.delete of the agent's disk
 *    is conflict while a VM of the agent runs" (thread VM, task VM).
 *  - M-create-overwrites: `disk.create` on an existing disk: killed by "disk.create refuses an existing disk".
 */
let fx: Fixture;
const use = (handler?: ExecHandler): void => {
  if ((fx as Fixture | undefined) !== undefined) fx.cleanup();
  fx = createFixture(handler);
};
afterEach(() => fx.cleanup());
const stateDir = (...parts: string[]): string => path.join(fx.state.root, ...parts);
const mkfs = (argv: readonly string[]): boolean => argv[0] === "/usr/sbin/mkfs.ext4";
const grow = (agentId = AGENT, diskMb = 8192): Record<string, unknown> => ({
  op: "disk.grow",
  agentId,
  taskKey: null,
  diskMb,
});
const del = (taskKey: string | null, purge = false): Record<string, unknown> => ({
  op: "disk.delete",
  agentId: AGENT,
  taskKey,
  purge,
});

describe("disk.create", () => {
  it("makes a sparse file of diskMb MiB and runs mkfs.ext4 -q -F on it", async () => {
    use();
    await fx.ops.handle({ op: "disk.create", agentId: AGENT, taskKey: null, diskMb: 4096 });
    const file = stateDir("agents", AGENT, "disk.img");
    const stat = statSync(file);
    expect(stat.size).toBe(4096 * MIB);
    expect(stat.blocks * 512).toBeLessThan(MIB);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(fx.exec.calls).toEqual([["/usr/sbin/mkfs.ext4", "-q", "-F", file]]);
    expect(fx.roomAsked).toEqual([4096]);
  });

  it("disk.create refuses an existing disk and leaves it alone", async () => {
    use();
    const file = seedDisk(fx);
    await expect(
      fx.ops.handle({ op: "disk.create", agentId: AGENT, taskKey: null, diskMb: 4096 }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(readFileSync(file, "utf8")).toBe("agent disk");
    expect(fx.exec.calls).toEqual([]);
  });

  it("disk_low makes nothing; a failed mkfs leaves no file", async () => {
    use();
    fx.room = () => Promise.reject(new VmdFailure("disk_low"));
    await expect(
      fx.ops.handle({ op: "disk.create", agentId: AGENT, taskKey: null, diskMb: 4096 }),
    ).rejects.toMatchObject({ code: "disk_low" });
    expect(existsSync(stateDir("agents", AGENT, "disk.img"))).toBe(false);
    use((argv) => (mkfs(argv) ? { code: 1 } : undefined));
    await expect(
      fx.ops.handle({ op: "disk.create", agentId: AGENT, taskKey: null, diskMb: 4096 }),
    ).rejects.toMatchObject({ code: "failed" });
    expect(existsSync(stateDir("agents", AGENT, "disk.img"))).toBe(false);
  });
});

describe("disk.grow (R31)", () => {
  it("disk.grow only extends the file: no e2fsck, no resize2fs, no mkfs", async () => {
    use();
    const file = seedDisk(fx);
    await fx.ops.handle({ op: "disk.create", agentId: OTHER_AGENT, taskKey: null, diskMb: 1024 });
    fx.exec.calls.length = 0;
    await fx.ops.handle(grow());
    expect(statSync(file).size).toBe(8192 * MIB);
    const head = Buffer.alloc(10);
    const fd = openSync(file, "r");
    readSync(fd, head, 0, 10, 0);
    closeSync(fd);
    expect(head.toString()).toBe("agent disk");
    expect(fx.exec.calls.map((argv) => argv.at(-1))).toEqual(["{{.Names}} {{.Status}}"]);
    expect(fx.roomAsked.at(-1)).toBe(8192);
  });

  it("disk.grow refuses a smaller size and leaves the file as it was", async () => {
    use();
    const file = stateDir("agents", AGENT, "disk.img");
    await fx.ops.handle({ op: "disk.create", agentId: AGENT, taskKey: null, diskMb: 4096 });
    await expect(fx.ops.handle(grow(AGENT, 2048))).rejects.toMatchObject({ code: "bad_request" });
    expect(statSync(file).size).toBe(4096 * MIB);
    await expect(fx.ops.handle(grow(AGENT, 4096))).resolves.toEqual({ diskMb: 4096 });
    expect(statSync(file).size).toBe(4096 * MIB);
  });

  it("disk.grow is conflict while a VM of the agent runs, not_found without a disk, failed when nerdctl cannot say", async () => {
    use();
    const file = seedDisk(fx);
    fx.ps = [`pap-${AGENT}-${TASK} Up 2 seconds`];
    await expect(fx.ops.handle(grow())).rejects.toMatchObject({ code: "conflict" });
    fx.ps = [`pap-${OTHER_AGENT} Up 2 seconds`];
    await expect(fx.ops.handle(grow(OTHER_AGENT))).rejects.toMatchObject({ code: "not_found" });
    await expect(fx.ops.handle(grow())).resolves.toEqual({ diskMb: 8192 });
    fx.psCode = 1;
    await expect(fx.ops.handle(grow(AGENT, 9000))).rejects.toMatchObject({ code: "failed" });
    expect(statSync(file).size).toBe(8192 * MIB);
  });

  it("disk.grow does not follow a link planted at the disk's path", async () => {
    use();
    const target = path.join(fx.work, "elsewhere");
    writeFileSync(target, "x");
    mkdirSync(stateDir("agents", AGENT), { recursive: true });
    symlinkSync(target, stateDir("agents", AGENT, "disk.img"));
    await expect(fx.ops.handle(grow())).rejects.toBeInstanceOf(VmdFailure);
    expect(statSync(target).size).toBe(1);
  });
});

describe("fail closed on a status pap does not know (I1)", () => {
  it("an unknown, a pausing or an empty status blocks disk.grow and disk.delete", async () => {
    use();
    const file = seedDisk(fx);
    for (const status of ["Unknown", "Pausing", "", "Removing"]) {
      fx.ps = [`pap-${AGENT} ${status}`.trimEnd()];
      await expect(fx.ops.handle(grow())).rejects.toMatchObject({ code: "conflict" });
      await expect(fx.ops.handle(del(null))).rejects.toMatchObject({ code: "conflict" });
      await expect(fx.ops.handle(del(null, true))).rejects.toMatchObject({ code: "conflict" });
      expect(existsSync(file)).toBe(true);
    }
    fx.ps = [`pap-${AGENT}`];
    await expect(fx.ops.handle(grow())).rejects.toMatchObject({ code: "conflict" });
  });

  it("an unknown status keeps a task disk out of the start sweep", async () => {
    use();
    for (const status of ["Unknown", "Pausing", ""]) {
      fx.ps = [`pap-${AGENT}-${TASK} ${status}`.trimEnd()];
      const disk = fx.state.diskPath(AGENT, TASK);
      mkdirSync(path.dirname(disk), { recursive: true });
      writeFileSync(disk, "task disk");
      fx.state.sweepAtStart(await fx.ops.runningTasks());
      expect(existsSync(disk)).toBe(true);
    }
    fx.ps = [`pap-${AGENT}-${TASK} Exited (0) 1 hour ago`];
    fx.state.sweepAtStart(await fx.ops.runningTasks());
    expect(existsSync(fx.state.diskPath(AGENT, TASK))).toBe(false);
  });
});

describe("disk.delete (R30)", () => {
  it("disk.delete of the agent's disk is conflict while a VM of the agent runs (thread or task)", async () => {
    use();
    const file = seedDisk(fx);
    for (const running of [`pap-${AGENT} Up 1 minute`, `pap-${AGENT}-${TASK} Up 1 minute`]) {
      fx.ps = [running];
      await expect(fx.ops.handle(del(null))).rejects.toMatchObject({ code: "conflict" });
      await expect(fx.ops.handle(del(null, true))).rejects.toMatchObject({ code: "conflict" });
      expect(existsSync(file)).toBe(true);
    }
  });

  it("moves the agent's folder to the trash as <id>-<stamp>, or removes it with purge", async () => {
    use();
    const file = seedDisk(fx);
    fx.ps = [`pap-${AGENT} Exited (0) 1 hour ago`];
    await fx.ops.handle(del(null));
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(stateDir("trash"))).toEqual([`${AGENT}-${fx.clock.now()}`]);
    expect(readFileSync(stateDir("trash", `${AGENT}-${fx.clock.now()}`, "disk.img"), "utf8")).toBe(
      "agent disk",
    );
    const second = seedDisk(fx, OTHER_AGENT);
    fx.ps = [];
    await fx.ops.handle({ op: "disk.delete", agentId: OTHER_AGENT, taskKey: null, purge: true });
    expect(existsSync(path.dirname(second))).toBe(false);
    expect(readdirSync(stateDir("trash"))).toHaveLength(1);
    await expect(fx.ops.handle(del(null))).rejects.toMatchObject({ code: "not_found" });
  });

  it("a task key removes that task disk when its VM is not running, and only that one", async () => {
    use();
    const agentDisk = seedDisk(fx);
    const other = "f".repeat(32);
    for (const key of [TASK, other]) {
      mkdirSync(stateDir("agents", AGENT, "tasks", key), { recursive: true });
      writeFileSync(stateDir("agents", AGENT, "tasks", key, "disk.img"), key);
    }
    fx.ps = [`pap-${AGENT}-${TASK} Up 5 seconds`];
    await expect(fx.ops.handle(del(TASK))).rejects.toMatchObject({ code: "conflict" });
    fx.ps = [`pap-${AGENT}-${other} Up 5 seconds`];
    await fx.ops.handle(del(TASK));
    expect(existsSync(stateDir("agents", AGENT, "tasks", TASK))).toBe(false);
    expect(existsSync(stateDir("agents", AGENT, "tasks", other, "disk.img"))).toBe(true);
    expect(existsSync(agentDisk)).toBe(true);
    await expect(fx.ops.handle(del(TASK))).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("trash.purge (RT-40)", () => {
  it("purges one agent's entries now, or the old ones for null", async () => {
    use();
    mkdirSync(stateDir("trash", `${AGENT}-${fx.clock.now()}`));
    mkdirSync(stateDir("trash", `${OTHER_AGENT}-${fx.clock.now()}`));
    await expect(fx.ops.handle({ op: "trash.purge", agentId: AGENT })).resolves.toEqual({ removed: 1 });
    expect(readdirSync(stateDir("trash"))).toEqual([`${OTHER_AGENT}-${fx.clock.now()}`]);
    await expect(fx.ops.handle({ op: "trash.purge", agentId: null })).resolves.toEqual({ removed: 0 });
  });
});
