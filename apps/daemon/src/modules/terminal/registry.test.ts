import { readFileSync } from "node:fs";
import { PapError } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { MAX_EXITED_KEPT, createTerminalRegistry, shellAlive, type TerminalChange } from "./registry.ts";
import { EXIT_QUIET_MS } from "./terminal.ts";
import { createFakePty, type FakePty } from "./testing/fake-pty.ts";
import { createFakeConnection } from "./testing/fake-stream.ts";

function setup(options: { max?: number; floor?: number; free?: number } = {}) {
  const clock = createFakeClock();
  const { logger } = captureLogger();
  const ptys: FakePty[] = [];
  const reaps = vi.fn<(exit: unknown) => Promise<{ oomKilled: boolean }>>(async () => ({ oomKilled: false }));
  const kill = vi.fn(async (target: { pid: number }) => {
    ptys.find((pty) => pty.pid === target.pid)?.exit(null, "SIGHUP");
  });
  const launch = vi.fn((input: { cwd: string; cols: number; rows: number }) => {
    void input;
    const pty = createFakePty(1000 + ptys.length, clock);
    ptys.push(pty);
    return { pty, scope: { reap: reaps } };
  });
  const registry = createTerminalRegistry({
    clock,
    logger,
    maxTerminals: options.max ?? 8,
    minFreeMemMb: options.floor ?? 0,
    freeMemMb: () => options.free ?? 10_000,
    launch,
    kill,
  });
  const changes: Array<[string, TerminalChange]> = [];
  registry.onChange((owner, change) => void changes.push([owner, change]));
  const create = (ownerId = "u1") =>
    registry.create({ ownerId, cwd: "/work", sessionId: null, cols: 80, rows: 24 });
  return { clock, ptys, kill, launch, reaps, registry, changes, create };
}

describe("create", () => {
  it("ids are 22 base64url characters and differ; the terminal is listed and announced", () => {
    const bed = setup();
    const a = bed.create();
    const b = bed.create();
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(b.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.id).not.toBe(b.id);
    expect(bed.registry.list("u1").map((t) => t.id)).toEqual([a.id, b.id]);
    expect(bed.registry.get("u1", a.id)).toBe(a);
    expect(bed.changes.map(([owner, change]) => [owner, change.kind])).toEqual([
      ["u1", "terminal"],
      ["u1", "terminal"],
    ]);
    expect(bed.launch).toHaveBeenCalledWith({ cwd: "/work", cols: 80, rows: 24 });
  });

  it("another owner's terminal is invisible", () => {
    const bed = setup();
    const mine = bed.create("u1");
    expect(bed.registry.get("u2", mine.id)).toBeNull();
    expect(bed.registry.list("u2")).toEqual([]);
  });

  it("refuses the 9th running terminal of one owner with capacity, never killing one; the other owner is unaffected", () => {
    const bed = setup();
    for (let i = 0; i < 8; i++) bed.create("u1");
    expect(() => bed.create("u1")).toThrow(expect.objectContaining({ code: "capacity" }));
    expect(bed.launch).toHaveBeenCalledTimes(8);
    expect(bed.kill).not.toHaveBeenCalled();
    expect(bed.create("u2").ownerId).toBe("u2");
    expect(bed.registry.list("u1")).toHaveLength(8);
  });

  it("honours a smaller PAP_MAX_TERMINALS", () => {
    const bed = setup({ max: 2 });
    bed.create();
    bed.create();
    expect(() => bed.create()).toThrow(PapError);
  });

  it("an exited terminal frees a running slot", async () => {
    const bed = setup({ max: 1 });
    bed.create();
    bed.ptys[0]?.exit(0);
    await bed.clock.advance(EXIT_QUIET_MS);
    expect(bed.create().view().status).toBe("running");
  });

  it("the free-memory floor refuses a create with capacity and starts nothing", () => {
    const bed = setup({ floor: 512, free: 511 });
    expect(() => bed.create()).toThrow(expect.objectContaining({ code: "capacity" }));
    expect(bed.launch).not.toHaveBeenCalled();
    const ok = setup({ floor: 512, free: 512 });
    expect(ok.create().view().status).toBe("running");
  });
});

describe("exited terminals", () => {
  it("keeps 8 and drops the oldest exited one on the 9th, announcing closed", async () => {
    const bed = setup({ max: 64 });
    const all = Array.from({ length: 9 }, () => bed.create());
    for (let i = 0; i < 9; i++) {
      bed.ptys[i]?.exit(i);
      await bed.clock.advance(EXIT_QUIET_MS);
    }
    expect(MAX_EXITED_KEPT).toBe(8);
    const kept = bed.registry.list("u1").map((t) => t.id);
    expect(kept).toEqual(all.slice(1).map((t) => t.id));
    expect(bed.changes.filter(([, c]) => c.kind === "closed")).toEqual([
      ["u1", { kind: "closed", id: all[0]?.id }],
    ]);
    expect(bed.registry.get("u1", all[0]?.id ?? "")).toBeNull();
    expect(bed.kill).not.toHaveBeenCalled();
  });

  it("drops by the order the shells ended, not the order they were created", async () => {
    const bed = setup({ max: 64 });
    const all = Array.from({ length: 9 }, () => bed.create());
    for (const i of [8, 0, 1, 2, 3, 4, 5, 6, 7]) {
      bed.ptys[i]?.exit(0);
      await bed.clock.advance(EXIT_QUIET_MS);
    }
    expect(bed.registry.get("u1", all[8]?.id ?? "")).toBeNull();
    expect(bed.registry.list("u1")).toHaveLength(8);
  });

  it("running terminals are never dropped by the exited cap", async () => {
    const bed = setup({ max: 64 });
    const running = bed.create();
    for (let i = 0; i < 10; i++) {
      bed.create();
      bed.ptys[i + 1]?.exit(0);
      await bed.clock.advance(EXIT_QUIET_MS);
    }
    expect(bed.registry.get("u1", running.id)).toBe(running);
    expect(bed.registry.list("u1").filter((t) => t.view().status === "exited")).toHaveLength(8);
  });

  it("closing a terminal removes it and announces closed once", async () => {
    const bed = setup();
    const terminal = bed.create();
    await terminal.close();
    await terminal.close();
    expect(bed.registry.list("u1")).toEqual([]);
    expect(bed.changes.filter(([, c]) => c.kind === "closed")).toHaveLength(1);
  });
});

describe("closeAll and listeners", () => {
  it("closeAll closes every terminal of every owner, and their streams", async () => {
    const bed = setup();
    const a = bed.create("u1");
    const b = bed.create("u2");
    const connection = createFakeConnection();
    a.attach("c1", (sink) => connection.open(sink), undefined);
    await bed.registry.closeAll();
    expect(bed.kill).toHaveBeenCalledTimes(2);
    expect(connection.last().closes).toBe(1);
    expect(bed.registry.list("u1")).toEqual([]);
    expect(bed.registry.list("u2")).toEqual([]);
    expect(
      bed.changes
        .filter(([, c]) => c.kind === "closed")
        .map(([owner]) => owner)
        .sort(),
    ).toEqual(["u1", "u2"]);
    expect(b.view().status).toBe("running");
  });

  it("a throwing listener does not stop the others, and an unsubscribed one hears nothing", () => {
    const bed = setup();
    const heard: string[] = [];
    bed.registry.onChange(() => {
      throw new Error("listener");
    });
    const off = bed.registry.onChange((_owner, change) => void heard.push(change.kind));
    bed.create();
    off();
    bed.create();
    expect(heard).toEqual(["terminal"]);
    expect(bed.changes).toHaveLength(2);
  });
});

describe("shellAlive", () => {
  const own = () => {
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
  };
  const pty = (pid: number, start: string | null) => ({ ...createFakePty(pid), pid, start });

  it("is true for the process with the start time read at spawn, false for another start or a missing pid", () => {
    expect(shellAlive(pty(process.pid, own()))).toBe(true);
    expect(shellAlive(pty(process.pid, `${own()}0`))).toBe(false);
    expect(shellAlive(pty(2 ** 22 + 12345, "1"))).toBe(false);
  });

  it("cannot tell without a start time and then says alive", () => {
    expect(shellAlive(pty(process.pid, null))).toBe(true);
  });
});
