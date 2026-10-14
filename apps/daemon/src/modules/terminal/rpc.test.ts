import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { makeModuleBed } from "./testing/module-bed.ts";

let bed: ReturnType<typeof makeModuleBed>;
afterEach(() => bed.cleanup());

const code = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof PapError ? error.code : `thrown: ${String(error)}`;
  }
  return "no error";
};

const other = () => bed.ctxOf(testCaller({ userId: "u2" }), "c2");

describe("terminal.attach", () => {
  it("opens a stream on the connection's channel and answers its place in the output", async () => {
    bed = makeModuleBed();
    const id = await bed.create();
    bed.child().emit("hello");
    const answer = await bed.rpc["terminal.attach"]({ terminalId: id }, bed.ctxOf());
    expect(answer).toEqual({ streamId: 1, start: 0, end: 5, cols: 80, rows: 24, status: "running" });
    bed.connection.last().commit();
    expect(bed.connection.last().text()).toBe("hello");
  });

  it("continues from `after`", async () => {
    bed = makeModuleBed();
    const id = await bed.create();
    bed.child().emit("hello world");
    const answer = await bed.rpc["terminal.attach"]({ terminalId: id, after: 6 }, bed.ctxOf());
    expect(answer).toMatchObject({ start: 6, end: 11 });
    bed.connection.last().commit();
    expect(bed.connection.last().shape()).toEqual([["output", 6]]);
  });

  it("a repeat from the same connection returns the same stream", async () => {
    bed = makeModuleBed();
    const id = await bed.create();
    const first = await bed.rpc["terminal.attach"]({ terminalId: id }, bed.ctxOf());
    const again = await bed.rpc["terminal.attach"]({ terminalId: id }, bed.ctxOf());
    expect(again.streamId).toBe(first.streamId);
    expect(bed.connection.streams).toHaveLength(1);
  });

  it("answers not_found for another owner's terminal and for an unknown id, opening nothing", async () => {
    bed = makeModuleBed();
    const id = await bed.create();
    expect(await code(bed.rpc["terminal.attach"]({ terminalId: id }, other()))).toBe("not_found");
    expect(await code(bed.rpc["terminal.attach"]({ terminalId: "B".repeat(22) }, bed.ctxOf()))).toBe(
      "not_found",
    );
    expect(bed.connection.streams).toHaveLength(0);
  });

  it("answers internal when the context has no binary channel (M8R4)", async () => {
    bed = makeModuleBed();
    const id = await bed.create();
    expect(
      await code(bed.rpc["terminal.attach"]({ terminalId: id }, bed.ctxOf(testCaller(), "c1", false))),
    ).toBe("internal");
  });

  it("answers capacity past eight streams", async () => {
    bed = makeModuleBed();
    const id = await bed.create();
    for (let index = 0; index < 8; index++)
      await bed.rpc["terminal.attach"]({ terminalId: id }, bed.ctxOf(testCaller(), `c${index}`));
    expect(await code(bed.rpc["terminal.attach"]({ terminalId: id }, bed.ctxOf(testCaller(), "c9")))).toBe(
      "capacity",
    );
  });

  it("an exited terminal answers status exited, then the ring, then the exit frame", async () => {
    bed = makeModuleBed();
    const id = await bed.create();
    bed.child().emit("bye");
    bed.child().end(3);
    await bed.clock.advance(2000);
    const answer = await bed.rpc["terminal.attach"]({ terminalId: id }, bed.ctxOf());
    expect(answer.status).toBe("exited");
    bed.connection.last().commit();
    expect(bed.connection.last().shape()).toEqual([
      ["reset", 0],
      ["output", 0],
      ["exit", 3],
    ]);
  });
});

describe("terminal.detach", () => {
  it("closes the caller's own stream and leaves the shell running", async () => {
    bed = makeModuleBed();
    const id = await bed.create();
    const { streamId } = await bed.rpc["terminal.attach"]({ terminalId: id }, bed.ctxOf());
    expect(await bed.rpc["terminal.detach"]({ streamId }, bed.ctxOf())).toEqual({ ok: true });
    expect(bed.connection.last().closes).toBe(1);
    expect(bed.kill).not.toHaveBeenCalled();
  });

  it("answers ok for an unknown stream", async () => {
    bed = makeModuleBed();
    await bed.create();
    expect(await bed.rpc["terminal.detach"]({ streamId: 77 }, bed.ctxOf())).toEqual({ ok: true });
  });

  it("never closes another connection's stream with the same id", async () => {
    bed = makeModuleBed();
    const id = await bed.create();
    const { streamId } = await bed.rpc["terminal.attach"]({ terminalId: id }, bed.ctxOf());
    await bed.rpc["terminal.detach"]({ streamId }, bed.ctxOf(testCaller(), "someone-else"));
    expect(bed.connection.last().closes).toBe(0);
  });
});

describe("terminal.resize", () => {
  it("resizes the PTY, the last size wins", async () => {
    bed = makeModuleBed();
    const id = await bed.create();
    await bed.rpc["terminal.resize"]({ terminalId: id, cols: 100, rows: 30 }, bed.ctxOf());
    await bed.rpc["terminal.resize"]({ terminalId: id, cols: 120, rows: 40 }, bed.ctxOf());
    expect(bed.child().resizes).toEqual([
      [100, 30],
      [120, 40],
    ]);
  });

  it("answers not_found for another owner's terminal", async () => {
    bed = makeModuleBed();
    const id = await bed.create();
    expect(await code(bed.rpc["terminal.resize"]({ terminalId: id, cols: 90, rows: 20 }, other()))).toBe(
      "not_found",
    );
    expect(bed.child().resizes).toEqual([]);
  });
});

describe("terminal.close", () => {
  it("closes twice with ok both times and one kill", async () => {
    bed = makeModuleBed();
    const id = await bed.create();
    expect(await bed.rpc["terminal.close"]({ terminalId: id }, bed.ctxOf())).toEqual({ ok: true });
    expect(await bed.rpc["terminal.close"]({ terminalId: id }, bed.ctxOf())).toEqual({ ok: true });
    expect(bed.kill).toHaveBeenCalledTimes(1);
    expect(bed.listed()).toMatchObject({ terminals: [] });
  });

  it("answers ok for another owner's id and closes nothing", async () => {
    bed = makeModuleBed();
    const id = await bed.create();
    expect(await bed.rpc["terminal.close"]({ terminalId: id }, other())).toEqual({ ok: true });
    expect(bed.kill).not.toHaveBeenCalled();
    expect(bed.listed()).toMatchObject({ terminals: [{ id }] });
  });

  it("answers ok for an unknown id", async () => {
    bed = makeModuleBed();
    expect(await bed.rpc["terminal.close"]({ terminalId: "B".repeat(22) }, bed.ctxOf())).toEqual({
      ok: true,
    });
  });
});

describe("subscribe.terminal", () => {
  it("opens the caller's own stream, keyed by the caller", async () => {
    bed = makeModuleBed();
    const opened: Array<[string, string, unknown]> = [];
    const ctx = {
      ...bed.ctxOf(),
      openSubscription: (stream: string, key: string, after: unknown) => {
        opened.push([stream, key, after]);
        return "s9";
      },
    };
    const cursor = { epoch: "e", seq: 2 };
    expect(await bed.rpc["subscribe.terminal"]({ after: cursor }, ctx)).toEqual({ sub: "s9" });
    expect(opened).toEqual([["terminal", "u1", cursor]]);
  });
});
