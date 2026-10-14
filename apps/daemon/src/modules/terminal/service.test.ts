import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { makeModuleBed } from "./testing/module-bed.ts";

let bed: ReturnType<typeof makeModuleBed>;
const setup = (options: Parameters<typeof makeModuleBed>[0] = {}) => (bed = makeModuleBed(options));
afterEach(() => bed.cleanup());

const refused = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PapError) return error.code;
    throw error;
  }
  return "no error";
};

describe("create: the working folder", () => {
  it("opens a folder of the caller's roots, spawns under its real path and lists it", async () => {
    setup();
    const id = await bed.create({ cwd: join(bed.project, "sub") });
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(bed.fake.spawn).toHaveBeenCalledTimes(1);
    expect(bed.child().options.cwd).toBe(join(bed.project, "sub"));
    expect(bed.listed()).toMatchObject({
      kind: "snapshot",
      terminals: [{ id, cwd: join(bed.project, "sub") }],
    });
  });

  it("follows a link to the folder and spawns under where it leads", async () => {
    setup();
    symlinkSync(join(bed.project, "sub"), join(bed.project, "link"));
    await bed.create({ cwd: join(bed.project, "link") });
    expect(bed.child().options.cwd).toBe(join(bed.project, "sub"));
  });

  it.each([
    ["a folder outside the roots", (b: typeof bed) => b.base],
    ["$PAP_HOME", (b: typeof bed) => b.papHome],
    ["Pi's private folder", (b: typeof bed) => b.agentDir],
    ["a file", (b: typeof bed) => join(b.project, "file.txt")],
    ["a folder that does not exist", (b: typeof bed) => join(b.project, "nowhere")],
  ])("answers not_found for %s and spawns nothing", async (_name, pick) => {
    setup();
    expect(await refused(bed.create({ cwd: pick(bed) }))).toBe("not_found");
    expect(bed.fake.spawn).not.toHaveBeenCalled();
    expect(bed.listed()).toMatchObject({ terminals: [] });
  });

  it("answers not_found to a caller with no project", async () => {
    setup();
    const stranger = bed.ctxOf(testCaller({ userId: "u3" }));
    expect(await refused(bed.create({}, stranger))).toBe("not_found");
  });
});

describe("create: spawn", () => {
  it("starts the shell with the daemon's umask, a clean environment and the tag", async () => {
    setup();
    await bed.create({ sessionId: "sess-1" });
    const shell = bed.child();
    expect(shell.args).toEqual([
      "-c",
      'umask "$1" && shift && exec "$@"',
      "pap-shell",
      "0027",
      "/bin/sh",
      "-l",
    ]);
    expect(shell.options.env.PAP_HOME).toBeUndefined();
    expect(shell.options.env.TERM).toBe("xterm-256color");
    expect(bed.scopeNext).toHaveBeenCalledWith({ kind: "terminal" });
    expect(bed.listed()).toMatchObject({ terminals: [{ sessionId: "sess-1", cols: 80, rows: 24 }] });
  });

  it("answers terminal_unavailable when node-pty did not load", async () => {
    setup({ pty: false });
    expect(await refused(bed.create({}))).toBe("terminal_unavailable");
    expect(bed.listed()).toMatchObject({ terminals: [] });
  });

  it("answers terminal_unavailable when the spawn fails, and keeps nothing", async () => {
    setup();
    bed.fake.spawn.mockImplementationOnce(() => {
      throw new Error("spawn refused for /secret/path");
    });
    expect(await refused(bed.create({}))).toBe("terminal_unavailable");
    expect(bed.listed()).toMatchObject({ terminals: [] });
    expect(JSON.stringify(bed.lines)).not.toContain("/secret/path");
    expect(bed.lines.filter((line) => line.msg === "terminal_spawn_failed")).toHaveLength(1);
  });

  it("reaps the scope of a shell that never started", async () => {
    setup({ scope: true });
    bed.fake.spawn.mockImplementationOnce(() => {
      throw new Error("spawn refused");
    });
    expect(await refused(bed.create({}))).toBe("terminal_unavailable");
    expect(bed.reap).toHaveBeenCalledExactlyOnceWith({ signal: null });
  });

  it("answers capacity past the cap and never kills a terminal", async () => {
    setup({ max: 2 });
    await bed.create({ requestId: "a".repeat(16) });
    await bed.create({ requestId: "b".repeat(16) });
    expect(await refused(bed.create({ requestId: "c".repeat(16) }))).toBe("capacity");
    expect(bed.kill).not.toHaveBeenCalled();
  });
});

describe("create: the client's request id", () => {
  it("returns the same terminal for a repeat, with one spawn", async () => {
    setup();
    const first = await bed.create();
    const again = await bed.create();
    expect(again).toBe(first);
    expect(bed.fake.spawn).toHaveBeenCalledTimes(1);
  });

  it("answers two simultaneous creates with one terminal", async () => {
    setup();
    const [a, b] = await Promise.all([bed.create(), bed.create()]);
    expect(a).toBe(b);
    expect(bed.fake.spawn).toHaveBeenCalledTimes(1);
  });

  it("a new id makes a second terminal", async () => {
    setup();
    const a = await bed.create({ requestId: "a".repeat(16) });
    const b = await bed.create({ requestId: "b".repeat(16) });
    expect(a).not.toBe(b);
    expect(bed.fake.spawn).toHaveBeenCalledTimes(2);
  });

  it("belongs to the owner: another owner's repeat makes its own terminal", async () => {
    setup();
    const mine = await bed.create();
    const theirs = await bed.create({}, bed.ctxOf(testCaller({ userId: "u2" })));
    expect(theirs).not.toBe(mine);
  });

  it("forgets the id once its terminal is dropped, and a repeat starts a new shell", async () => {
    setup();
    const first = await bed.create();
    await bed.rpc["terminal.close"]({ terminalId: first }, bed.ctxOf());
    const second = await bed.create();
    expect(second).not.toBe(first);
    expect(bed.fake.spawn).toHaveBeenCalledTimes(2);
  });

  it("a failed create does not keep its id: the retry can succeed", async () => {
    setup();
    expect(await refused(bed.create({ cwd: join(bed.project, "nowhere") }))).toBe("not_found");
    expect(await bed.create()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("forgets the id of an exited terminal dropped for the eight kept: its repeat starts a new shell", async () => {
    setup({ max: 1 });
    const first = await bed.create({ requestId: "0".repeat(16) });
    bed.child(0).end(0);
    await bed.clock.advance(2000);
    for (let index = 1; index <= 9; index++) {
      await bed.create({ requestId: String(index).padStart(16, "q") });
      bed.child(index).end(0);
      await bed.clock.advance(2000);
    }
    const kept = bed.listed();
    expect(kept.kind === "snapshot" && kept.terminals.length).toBe(8);
    const again = await bed.create({ requestId: "0".repeat(16) });
    expect(again).not.toBe(first);
    expect(bed.fake.spawn).toHaveBeenCalledTimes(11);
  });
});

describe("create: the remembered request ids are bounded", () => {
  it("refuses a request id past the cap plus eight exited ones without judging its folder", async () => {
    setup({ max: 1 });
    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) => bed.create({ requestId: String(index).padStart(16, "w") })),
    );
    expect(bed.judged).toHaveLength(9);
    expect(settled.map((outcome) => outcome.status)).toEqual(
      Array.from({ length: 10 }, () => "rejected").map((_, i) => (i === 0 ? "fulfilled" : "rejected")),
    );
    expect(
      settled
        .slice(1)
        .map((outcome) => (outcome.status === "rejected" ? (outcome.reason as PapError).code : "")),
    ).toEqual(Array.from({ length: 9 }, () => "capacity"));
    // The refused ids left nothing behind: with the first terminal closed, a new id works.
    await bed.rpc["terminal.close"](
      { terminalId: (settled[0] as PromiseFulfilledResult<string>).value },
      bed.ctxOf(),
    );
    expect(await bed.create({ requestId: "y".repeat(16) })).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe("the terminal stream", () => {
  it("snapshots the owner's own terminals only", async () => {
    setup();
    await bed.create();
    await bed.create({ requestId: "o".repeat(16) }, bed.ctxOf(testCaller({ userId: "u2" })));
    expect(bed.listed("u1")).toMatchObject({ terminals: [{}] });
    expect(bed.listed("u2")).toMatchObject({ terminals: [{}] });
    expect(bed.listed("u9")).toEqual({ kind: "snapshot", terminals: [] });
  });

  it("publishes create, resize, exit and close to the owner", async () => {
    setup();
    const seen: Array<{ kind: string; status?: string; cols?: number }> = [];
    bed.hub
      .prepare({
        connectionId: "watch",
        sub: "w",
        stream: "terminal",
        key: "u1",
        after: undefined,
        send: (frame) => {
          const event = frame.event as {
            kind: string;
            terminal?: { status: string; cols: number };
          };
          seen.push({ kind: event.kind, status: event.terminal?.status, cols: event.terminal?.cols });
        },
      })
      .commit();
    const id = await bed.create();
    await bed.rpc["terminal.resize"]({ terminalId: id, cols: 100, rows: 30 }, bed.ctxOf());
    bed.child().end(0);
    await bed.clock.advance(2000);
    await bed.rpc["terminal.close"]({ terminalId: id }, bed.ctxOf());
    expect(seen.map((s) => [s.kind, s.status, s.cols])).toEqual([
      ["snapshot", undefined, undefined],
      ["terminal", "running", 80],
      ["terminal", "running", 100],
      ["terminal", "exited", 100],
      ["closed", undefined, undefined],
    ]);
  });

  it("lists every terminal of the owner, 64 at the highest cap", async () => {
    setup({ max: 64 });
    for (let index = 0; index < 64; index++) await bed.create({ requestId: String(index).padStart(16, "n") });
    const event = bed.listed();
    expect(event.kind === "snapshot" && event.terminals.length).toBe(64);
  });
});

describe("shutdown (MC28)", () => {
  it("refuses a create once it has started, and spawns nothing", async () => {
    setup();
    await bed.module.shutdown();
    expect(await refused(bed.create({}))).toBe("capacity");
    // The service's own refusal comes before the folder is judged; the registry's check alone would leave one entry.
    expect(bed.judged).toEqual([]);
    expect(bed.fake.spawn).not.toHaveBeenCalled();
  });

  it("refuses a create that was still judging its folder when it started", async () => {
    setup();
    const pending = refused(bed.create({}));
    const stopping = bed.module.shutdown();
    expect(await pending).toBe("capacity");
    await stopping;
    // The create got past the service's check and was judging: the registry refused it afterwards.
    expect(bed.judged).toEqual(["u1"]);
    expect(bed.fake.spawn).not.toHaveBeenCalled();
    expect(bed.listed()).toMatchObject({ terminals: [] });
  });

  it("closes every terminal through the kill ladder", async () => {
    setup();
    await bed.create({ requestId: "a".repeat(16) });
    await bed.create({ requestId: "b".repeat(16) });
    await bed.module.shutdown();
    expect(bed.kill).toHaveBeenCalledTimes(2);
    expect(bed.listed()).toMatchObject({ terminals: [] });
  });
});
