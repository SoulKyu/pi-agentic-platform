import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { ALIVE_POLL_MS, EXIT_QUIET_MS, EXIT_WAIT_MAX_MS, MAX_STREAMS_PER_TERMINAL } from "./terminal.ts";
import { makeBed } from "./testing/bed.ts";

const KIB = 1024;
const MIB = KIB * KIB;
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const mustNotOpen = () => {
  throw new Error("a repeat attach must not open a stream");
};

describe("attach", () => {
  it("continues from `after` when it is inside the ring: the first frame is output at `after`", () => {
    const bed = makeBed();
    bed.pty.emit("hello world");
    const { stream, info } = bed.connect("c1", 6);
    stream.commit();
    expect(stream.shape()).toEqual([["output", 6]]);
    expect(stream.text()).toBe("world");
    expect(info).toMatchObject({ start: 6, end: 11, cols: 80, rows: 24, status: "running" });
  });

  it("`after` equal to the end continues with nothing to replay", () => {
    const bed = makeBed();
    bed.pty.emit("abc");
    const { stream } = bed.connect("c1", 3);
    stream.commit();
    expect(stream.frames).toEqual([]);
    bed.pty.emit("d");
    expect(stream.shape()).toEqual([["output", 3]]);
  });

  it("starts with a reset and the ring when `after` is missing, before safeStart() or past the end", () => {
    const missing = makeBed();
    missing.pty.emit("abc");
    const a = missing.connect("c1");
    a.stream.commit();
    expect(a.stream.shape()).toEqual([
      ["reset", 0],
      ["output", 0],
    ]);

    const past = makeBed();
    past.pty.emit("abc");
    const b = past.connect("c1", 4);
    b.stream.commit();
    expect(b.stream.shape()[0]).toEqual(["reset", 0]);

    const old = makeBed();
    for (let i = 0; i < 80; i++) old.pty.emit(new Uint8Array(64 * KIB).fill(0x61));
    const c = old.connect("c1", 0);
    c.stream.commit();
    expect(c.stream.frames[0]?.op).toBe("reset");
    expect(c.stream.frames[0]?.seq).toBe(80 * 64 * KIB - 4 * MIB);
    expect(c.info.start).toBe(80 * 64 * KIB - 4 * MIB);
  });

  it("waits for the answer: no frame before onOpen", () => {
    const bed = makeBed();
    const { stream } = bed.connect("c1");
    bed.pty.emit("early");
    expect(stream.frames).toEqual([]);
    stream.commit();
    expect(stream.text()).toBe("early");
  });

  it("a repeat attach from the same connection returns its stream and opens nothing", () => {
    const bed = makeBed();
    const first = bed.connect("c1");
    const again = bed.terminal.attach("c1", mustNotOpen, 0);
    expect(again.streamId).toBe(first.info.streamId);
    expect(bed.terminal.streamOf("c1")?.streamId).toBe(first.info.streamId);
    expect(bed.terminal.streamOf("other")).toBeNull();
  });

  it("refuses the 9th stream with capacity and keeps the 8 it has", () => {
    const bed = makeBed();
    for (let i = 0; i < MAX_STREAMS_PER_TERMINAL; i++) bed.connect(`c${i}`);
    expect(MAX_STREAMS_PER_TERMINAL).toBe(8);
    expect(() => bed.connect("c9")).toThrow(PapError);
    expect(() => bed.connect("c9")).toThrow(expect.objectContaining({ code: "capacity" }));
    expect(bed.terminal.streamOf("c0")).not.toBeNull();
  });

  it("frees a slot when a stream closes and tells nobody twice", () => {
    const bed = makeBed();
    const streams = Array.from({ length: 8 }, (_, i) => bed.connect(`c${i}`).stream);
    streams[3]?.close();
    expect(streams[3]?.closes).toBe(1);
    expect(bed.connect("fresh").info.streamId).toBeGreaterThan(0);
  });

  it("detach closes the connection's own stream once; a wrong connection or id changes nothing", () => {
    const bed = makeBed();
    const a = bed.connect("a");
    const b = bed.connect("b");
    bed.terminal.detach("b", a.info.streamId + 5);
    bed.terminal.detach("zzz", a.info.streamId);
    expect(a.stream.closes + b.stream.closes).toBe(0);
    bed.terminal.detach("a", a.info.streamId);
    bed.terminal.detach("a", a.info.streamId);
    expect(a.stream.closes).toBe(1);
    expect(bed.terminal.streamOf("a")).toBeNull();
    expect(bed.terminal.streamOf("b")).not.toBeNull();
  });

  it("a stream detached before its answer went out never opens (RT-30)", () => {
    const bed = makeBed();
    const a = bed.connect("a");
    bed.terminal.detach("a", a.info.streamId);
    bed.pty.emit("x");
    a.stream.commit();
    expect(a.stream.frames).toEqual([]);
  });
});

describe("input and resize", () => {
  it("writes seq 1, 2, 2, 1, 3 as three payloads in order", () => {
    const bed = makeBed();
    const { stream } = bed.connect("c1");
    stream.commit();
    for (const [seq, text] of [
      [1, "a"],
      [2, "b"],
      [2, "X"],
      [1, "Y"],
      [3, "c"],
    ] as const)
      stream.input(seq, text);
    expect(bed.pty.writes.map(decode)).toEqual(["a", "b", "c"]);
  });

  it("keeps a last sequence per stream and drops seq 0", () => {
    const bed = makeBed();
    const a = bed.connect("a").stream;
    const b = bed.connect("b").stream;
    a.commit();
    b.commit();
    a.input(5, "a5");
    b.input(1, "b1");
    a.input(0, "zero");
    a.input(4, "a4");
    expect(bed.pty.writes.map(decode)).toEqual(["a5", "b1"]);
  });

  it("drops input from a stream of another terminal and from a detached stream", () => {
    const one = makeBed();
    const two = makeBed();
    const mine = one.connect("c1");
    const theirs = two.connect("c1");
    mine.stream.commit();
    theirs.stream.commit();
    theirs.stream.input(1, "to-two");
    expect(one.pty.writes).toEqual([]);
    expect(two.pty.writes.map(decode)).toEqual(["to-two"]);
    one.terminal.detach("c1", mine.info.streamId);
    mine.stream.input(1, "late");
    expect(one.pty.writes).toEqual([]);
  });

  it("drops input once the shell exited", async () => {
    const bed = makeBed();
    const { stream } = bed.connect("c1");
    stream.commit();
    bed.pty.exit(0);
    await bed.clock.advance(EXIT_QUIET_MS);
    stream.input(1, "late");
    expect(bed.pty.writes).toEqual([]);
  });

  it("clamps the size, calls the PTY once per call, and the last call wins", () => {
    const bed = makeBed();
    bed.terminal.resize(1000, 1);
    bed.terminal.resize(100, 30);
    expect(bed.pty.resizes).toEqual([
      { cols: 500, rows: 2 },
      { cols: 100, rows: 30 },
    ]);
    expect(bed.terminal.view()).toMatchObject({ cols: 100, rows: 30 });
    expect(bed.changes.map((v) => [v.cols, v.rows])).toEqual([
      [500, 2],
      [100, 30],
    ]);
    expect(bed.connect("c1").info).toMatchObject({ cols: 100, rows: 30 });
  });
});

describe("a failing stream", () => {
  it("does not stop the others from getting the output, and is logged", () => {
    const bed = makeBed();
    const broken = bed.connect("a").stream;
    const healthy = bed.connect("b").stream;
    broken.commit();
    healthy.commit();
    (broken.stream as { send: unknown }).send = () => {
      throw new RangeError("frame");
    };
    bed.pty.emit("still here");
    expect(healthy.text()).toBe("still here");
    expect(bed.lines.some((line) => line.msg === "terminal_stream_failed")).toBe(true);
  });
});

describe("exit", () => {
  it("sends the remaining output, then exit with the code and signal, and records the status", async () => {
    const bed = makeBed();
    const { stream } = bed.connect("c1");
    stream.commit();
    bed.pty.emit("bye\n");
    bed.pty.exit(3);
    await bed.clock.advance(0);
    expect(bed.terminal.view().status).toBe("running");
    await bed.clock.advance(EXIT_QUIET_MS);
    expect(stream.shape()).toEqual([
      ["reset", 0],
      ["output", 0],
      ["exit", 4],
    ]);
    expect(JSON.parse(decode(stream.frames.at(-1)?.payload ?? new Uint8Array()))).toEqual({
      code: 3,
      signal: null,
    });
    expect(bed.terminal.view()).toMatchObject({ status: "exited", exitCode: 3, signal: null });
    expect(bed.calls.exited).toBe(1);
    expect(bed.changes.at(-1)?.status).toBe("exited");
  });

  it("the fake PTY emits exit, then a last chunk 50 ms later: the chunk is framed before the exit frame", async () => {
    const bed = makeBed();
    const { stream } = bed.connect("c1");
    stream.commit();
    bed.pty.exit(null, "SIGTERM");
    await bed.clock.advance(50);
    bed.pty.emit("last line\n");
    await bed.clock.advance(EXIT_QUIET_MS - 1);
    expect(stream.frames.map((f) => f.op)).toEqual(["reset", "output"]);
    await bed.clock.advance(1);
    expect(stream.frames.map((f) => f.op)).toEqual(["reset", "output", "exit"]);
    expect(stream.text()).toBe("last line\n");
    expect(bed.terminal.view()).toMatchObject({ exitCode: null, signal: "SIGTERM" });
  });

  it("gives up waiting for quiet after one second, though output keeps coming", async () => {
    const bed = makeBed();
    bed.connect("c1").stream.commit();
    bed.pty.exit(0);
    // A chunk every 90 ms keeps the quiet timer from ever firing; the one-second cap ends the wait at 1000 ms.
    for (let tick = 0; tick < 11; tick++) {
      await bed.clock.advance(90);
      bed.pty.emit("tick");
    }
    expect(bed.terminal.view().status).toBe("running");
    await bed.clock.advance(EXIT_WAIT_MAX_MS - 990);
    expect(bed.terminal.view().status).toBe("exited");
    expect(bed.clock.pending()).toBe(0);
  });

  it("the exit frame of a paused stream waits for its ack", async () => {
    const bed = makeBed();
    const { stream } = bed.connect("c1");
    stream.commit();
    for (let i = 0; i < 10; i++) bed.pty.emit(new Uint8Array(64 * KIB).fill(0x61));
    bed.pty.exit(0);
    await bed.clock.advance(ALIVE_POLL_MS + EXIT_QUIET_MS);
    expect(bed.terminal.view().status).toBe("exited");
    expect(stream.frames.some((f) => f.op === "exit")).toBe(false);
    stream.ack(300 * KIB);
    expect(stream.frames.at(-1)?.op).toBe("exit");
    expect(stream.frames.at(-1)?.seq).toBe(640 * KIB);
  });

  it("resumes a paused PTY whose shell was alive at the first poll tick and died after it (the poll re-arms)", async () => {
    const bed = makeBed();
    bed.connect("c1").stream.commit();
    for (let i = 0; i < 10; i++) bed.pty.emit(new Uint8Array(64 * KIB).fill(0x61));
    expect(bed.pty.paused).toBe(true);
    await bed.clock.advance(ALIVE_POLL_MS);
    expect(bed.pty.paused).toBe(true);
    bed.pty.emit("last words");
    bed.pty.exit(0);
    await bed.clock.advance(ALIVE_POLL_MS);
    expect(bed.pty.paused).toBe(false);
    await bed.clock.advance(EXIT_QUIET_MS);
    expect(bed.terminal.view().status).toBe("exited");
    expect(bed.connect("late").info.end).toBe(640 * KIB + "last words".length);
  });

  it("attaching to an exited terminal sends the ring from `after` or a reset, then exit", async () => {
    const bed = makeBed();
    bed.pty.emit("history");
    bed.pty.exit(0);
    await bed.clock.advance(EXIT_QUIET_MS);
    const late = bed.connect("c1");
    late.stream.commit();
    expect(late.stream.shape()).toEqual([
      ["reset", 0],
      ["output", 0],
      ["exit", 7],
    ]);
    expect(late.info.status).toBe("exited");
    const resumed = bed.connect("c2", 3);
    resumed.stream.commit();
    expect(resumed.stream.shape()).toEqual([
      ["output", 3],
      ["exit", 7],
    ]);
  });

  it("reaps the terminal's scope once the shell is gone", async () => {
    const bed = makeBed({ withScope: true });
    bed.pty.exit(null, "SIGKILL");
    await bed.clock.advance(EXIT_QUIET_MS);
    expect(bed.reap).toHaveBeenCalledTimes(1);
    expect(bed.reap).toHaveBeenCalledWith({ signal: "SIGKILL" });
    await bed.terminal.close();
    expect(bed.reap).toHaveBeenCalledTimes(1);
    expect(bed.kill).not.toHaveBeenCalled();
  });
});

describe("close", () => {
  it("kills the shell, then reaps its scope, closes every stream once and reports closed", async () => {
    const bed = makeBed({ withScope: true });
    const order: string[] = [];
    bed.kill.mockImplementation(async () => {
      order.push("kill");
      bed.pty.exit(null, "SIGHUP");
    });
    bed.reap.mockImplementation(async () => {
      order.push("reap");
      return { oomKilled: false };
    });
    const a = bed.connect("a").stream;
    const b = bed.connect("b").stream;
    a.commit();
    await Promise.all([bed.terminal.close(), bed.terminal.close()]);
    expect(order).toEqual(["kill", "reap"]);
    expect(bed.kill).toHaveBeenCalledTimes(1);
    expect(bed.kill).toHaveBeenCalledWith({ pid: bed.pty.pid, start: "1", exited: bed.pty.exited });
    expect([a.closes, b.closes]).toEqual([1, 1]);
    expect(bed.calls.closed).toBe(1);
    expect(() => bed.connect("late")).toThrow(PapError);
  });

  it("still closes the streams and reports closed when the kill fails, and logs it", async () => {
    const bed = makeBed();
    bed.kill.mockRejectedValue(new Error("boom"));
    const a = bed.connect("a").stream;
    await bed.terminal.close();
    expect(a.closes).toBe(1);
    expect(bed.calls.closed).toBe(1);
    expect(bed.lines.some((line) => line.msg === "terminal_kill_failed")).toBe(true);
  });

  it("drops output and input that arrive while it closes", async () => {
    const bed = makeBed();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    bed.kill.mockImplementation(() => gate);
    const a = bed.connect("a").stream;
    a.commit();
    const closing = bed.terminal.close();
    bed.pty.emit("late output");
    a.input(1, "late input");
    expect(a.frames.filter((f) => f.op === "output")).toEqual([]);
    expect(bed.pty.writes).toEqual([]);
    release();
    await closing;
    expect(bed.kill).toHaveBeenCalledTimes(1);
    expect(a.closes).toBe(1);
    expect(bed.calls.closed).toBe(1);
    expect(bed.clock.pending()).toBe(0);
  });
});
