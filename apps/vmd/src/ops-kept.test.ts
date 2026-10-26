import {
  readFileSync,
  writeFileSync,
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT,
  AGENT_BOX,
  createFixture,
  MIB,
  startRequest,
  TASK,
  type Fixture,
} from "./testing/ops-fixture.ts";
import type { ExecHandler } from "./testing/fake-exec.ts";

/*
 * A trigger's isolated task keeps its disk in `kept/<keepKey>/` (K-R1). Mutants killed here, run for real:
 *  - M-kept-removed-at-stop: `vm.stop` removes the kept folder: killed by "stopping a kept VM leaves the kept disk".
 *  - M-kept-remade: a kept start runs mkfs again on an existing disk: killed by "a second kept start reuses the disk".
 *  - M-kept-no-grow: a bigger diskMb leaves the file: killed by "a kept start with a larger diskMb grows the file".
 *  - M-kept-no-holder-check: no `conflict` for a live holder: killed by the two conflict tests.
 *  - M-kept-failed-start-removes-old: a failed start removes a disk of an earlier run: killed by "a failed kept start keeps
 *    an older disk".
 */
const KEEP = "9".repeat(32);
const TASK2 = "d".repeat(32);
const mkfs = (argv: readonly string[]): boolean => argv[0] === "/usr/sbin/mkfs.ext4";
const isRun = (argv: readonly string[]): boolean => argv.includes("run");
const keptRequest = (taskKey = TASK, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  startRequest({ kind: "isolated", taskKey, keepKey: KEEP, ...extra });
const del = (keepKey: string): Record<string, unknown> => ({
  op: "disk.delete",
  box: AGENT_BOX,
  taskKey: null,
  keepKey,
  purge: false,
});

/** The disk is sparse and 4 GiB: a mark written at its start, read back without loading the file. */
const mark = (file: string, text: string): void => {
  const fd = openSync(file, "r+");
  try {
    writeSync(fd, text, 0);
  } finally {
    closeSync(fd);
  }
};
const marked = (file: string, length: number): string => {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, 0);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
};

let fx: Fixture;
const use = (handler?: ExecHandler): string => {
  if ((fx as Fixture | undefined) !== undefined) fx.cleanup();
  fx = createFixture(handler, { holdsFile: () => false });
  return fx.state.keptPath(AGENT_BOX, KEEP);
};
afterEach(() => fx.cleanup());

describe("vm.start with a keepKey", () => {
  it("the first start makes the disk in kept/, a second reuses it without mkfs", async () => {
    const kept = use();
    await fx.ops.handle(keptRequest());
    expect(fx.exec.calls.filter(mkfs)).toEqual([["/usr/sbin/mkfs.ext4", "-q", "-F", kept]]);
    expect(statSync(kept).size).toBe(4096 * MIB);
    expect(existsSync(fx.state.diskPath(AGENT_BOX, TASK))).toBe(false);
    mark(kept, "left by run 1");
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: TASK });
    fx.exec.calls.length = 0;
    await fx.ops.handle(keptRequest(TASK2));
    expect(fx.exec.calls.filter(mkfs)).toEqual([]);
    expect(marked(kept, 13)).toBe("left by run 1");
    const add = fx.exec.calls.find((argv) => argv.includes("direct-volume") && argv.includes("add"));
    expect(add?.[4]).toContain(JSON.stringify(kept).slice(1, -1));
  });

  it("asks for room only when the disk is made", async () => {
    use();
    await fx.ops.handle(keptRequest());
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: TASK });
    await fx.ops.handle(keptRequest(TASK2));
    expect(fx.roomAsked).toEqual([4096]);
  });

  it("a kept start with a larger diskMb grows the file", async () => {
    const kept = use();
    await fx.ops.handle(keptRequest());
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: TASK });
    await fx.ops.handle(keptRequest(TASK2, { resources: { memoryMb: 1024, cpus: 1, diskMb: 8192 } }));
    expect(statSync(kept).size).toBe(8192 * MIB);
    expect(fx.roomAsked).toEqual([4096]);
  });

  it("a smaller diskMb never shrinks the file", async () => {
    const kept = use();
    await fx.ops.handle(keptRequest());
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: TASK });
    await fx.ops.handle(keptRequest(TASK2, { resources: { memoryMb: 1024, cpus: 1, diskMb: 2048 } }));
    expect(statSync(kept).size).toBe(4096 * MIB);
  });

  it("stopping a kept VM leaves the kept disk; stopping a plain task VM removes tasks/<key>/", async () => {
    const kept = use();
    await fx.ops.handle(keptRequest());
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: TASK });
    expect(existsSync(kept)).toBe(true);
    const plain = fx.state.diskPath(AGENT_BOX, TASK2);
    await fx.ops.handle(startRequest({ kind: "isolated", taskKey: TASK2 }));
    expect(existsSync(plain)).toBe(true);
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: TASK2 });
    expect(existsSync(path.dirname(plain))).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });

  it("a start while another live VM holds the same kept disk is a conflict", async () => {
    const kept = use();
    await fx.ops.handle(keptRequest());
    fx.ps = [`pap-${AGENT}-${TASK} Up 1 minute`];
    await expect(fx.ops.handle(keptRequest(TASK2))).rejects.toMatchObject({ code: "conflict" });
    expect(existsSync(kept)).toBe(true);
    expect(fx.exec.calls.filter(isRun)).toHaveLength(1);
  });

  it("a holder that has exited is no conflict", async () => {
    use();
    await fx.ops.handle(keptRequest());
    fx.ps = [`pap-${AGENT}-${TASK} Exited (0) 1 minute ago`];
    await expect(fx.ops.handle(keptRequest(TASK2))).resolves.toMatchObject({});
  });

  it("a process holding the file, unknown to pap-vmd, is a conflict", async () => {
    let held = false;
    if ((fx as Fixture | undefined) !== undefined) fx.cleanup();
    fx = createFixture(undefined, { holdsFile: () => held });
    await fx.ops.handle(keptRequest());
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: TASK });
    held = true;
    await expect(fx.ops.handle(keptRequest(TASK2))).rejects.toMatchObject({ code: "conflict" });
    held = false;
    await expect(fx.ops.handle(keptRequest(TASK2))).resolves.toMatchObject({});
  });

  it("a failed kept start removes the disk it just made", async () => {
    const kept = use((argv) => (isRun(argv) ? { code: 1 } : undefined));
    await expect(fx.ops.handle(keptRequest())).rejects.toMatchObject({ code: "failed" });
    expect(existsSync(path.dirname(kept))).toBe(false);
  });

  it("a failed kept start keeps an older disk", async () => {
    let failRun = false;
    const kept = use((argv) => (isRun(argv) && failRun ? { code: 1 } : undefined));
    await fx.ops.handle(keptRequest());
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: TASK });
    mark(kept, "older");
    failRun = true;
    await expect(fx.ops.handle(keptRequest(TASK2))).rejects.toMatchObject({ code: "failed" });
    expect(marked(kept, 5)).toBe("older");
  });
});

describe("disk.delete with a keepKey", () => {
  it("removes kept/<keepKey>/", async () => {
    const kept = use();
    await fx.ops.handle(keptRequest());
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: TASK });
    await expect(fx.ops.handle(del(KEEP))).resolves.toEqual({ deleted: true });
    expect(existsSync(path.dirname(kept))).toBe(false);
    expect(existsSync(fx.state.boxDir(AGENT_BOX))).toBe(true);
  });

  it("is a conflict while a live VM holds the disk, not_found when there is none", async () => {
    const kept = use();
    await expect(fx.ops.handle(del(KEEP))).rejects.toMatchObject({ code: "not_found" });
    await fx.ops.handle(keptRequest());
    fx.ps = [`pap-${AGENT}-${TASK} Up 1 minute`];
    await expect(fx.ops.handle(del(KEEP))).rejects.toMatchObject({ code: "conflict" });
    expect(existsSync(kept)).toBe(true);
  });

  it("never touches the agent's own folder or disk", async () => {
    use();
    const own = path.join(fx.state.boxDir(AGENT_BOX), "disk.img");
    await fx.ops.handle(keptRequest());
    await fx.ops.handle({ op: "vm.stop", box: AGENT_BOX, taskKey: TASK });
    writeFileSync(own, "agent disk");
    await fx.ops.handle(del(KEEP));
    expect(readFileSync(own, "utf8")).toBe("agent disk");
  });
});
