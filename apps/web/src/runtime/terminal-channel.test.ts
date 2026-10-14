import { CLIENT_OPS, decodeFrame, FRAME_OPS, MAX_FRAME_PAYLOAD } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "./rpc.ts";
import { TERMINAL_ID, terminalBed } from "../testing/terminal-bed.ts";
import { flush } from "./testing.ts";

const KIB = 1024;

afterEach(() => vi.restoreAllMocks());

async function opened(options: { manualWrites?: boolean } = {}) {
  const bed = terminalBed(options);
  const handle = bed.channel.open(TERMINAL_ID, bed.sink);
  await flush();
  return { bed, handle };
}

describe("terminal channel attach (M8R69)", () => {
  it("attaches without `after` and reports the attach answer", async () => {
    const { bed } = await opened();
    expect(bed.called("terminal.attach")).toEqual([
      { method: "terminal.attach", params: { terminalId: TERMINAL_ID } },
    ]);
    expect(bed.sink.attached).toHaveBeenCalledExactlyOnceWith({
      start: 0,
      end: 0,
      cols: 80,
      rows: 24,
      status: "running",
    });
    expect(bed.sink.state.mock.calls.map(([state]) => state)).toEqual(["attaching", "live"]);
  });

  it("is offline, and attaches on open, when the socket is not open yet", async () => {
    const bed = terminalBed();
    bed.fake.setState("waiting");
    bed.channel.open(TERMINAL_ID, bed.sink);
    await flush();
    expect(bed.sink.state).toHaveBeenLastCalledWith("offline");
    expect(bed.called("terminal.attach")).toEqual([]);
    bed.fake.setState("open");
    await flush();
    expect(bed.called("terminal.attach")).toHaveLength(1);
  });

  it("opens one attachment per terminal: a second open of the same terminal is refused", async () => {
    const { bed } = await opened();
    expect(() => bed.channel.open(TERMINAL_ID, bed.sink)).toThrow(/already open/);
  });

  it("a reset frame resets the sink and output frames reach it in order", async () => {
    const { bed } = await opened();
    bed.reset(1, 100);
    bed.output(1, 100, "ab");
    bed.output(1, 102, "cd");
    expect(bed.log).toEqual(["reset", "output:102", "output:104"]);
    expect(new TextDecoder().decode(bed.sink.output.mock.calls[0]?.[0])).toBe("ab");
  });

  it("an exit frame reaches the sink once the earlier writes are on screen", async () => {
    const { bed } = await opened({ manualWrites: true });
    bed.output(1, 0, "ab");
    bed.exit(1, 2, 3, null);
    expect(bed.log).toEqual(["output:2"]);
    await bed.finishWrites(1);
    expect(bed.log).toEqual(["output:2", "exit:3:null"]);
  });

  it("a frame for an unknown stream is dropped", async () => {
    const { bed } = await opened();
    bed.output(99, 0, "zz");
    expect(bed.sink.output).not.toHaveBeenCalled();
  });

  it("not_found on attach is final: state gone, no attach after a reconnect", async () => {
    const bed = terminalBed();
    bed.handlers["terminal.attach"] = () => {
      throw new RpcError("not_found");
    };
    bed.channel.open(TERMINAL_ID, bed.sink);
    await flush();
    expect(bed.sink.state).toHaveBeenLastCalledWith("gone");
    bed.fake.setState("waiting");
    bed.fake.setState("open");
    await flush();
    expect(bed.called("terminal.attach")).toHaveLength(1);
    expect(bed.sink.state).toHaveBeenLastCalledWith("gone");
  });

  it("close sends terminal.detach and drops the stream's later frames", async () => {
    const { bed, handle } = await opened();
    handle.close();
    await flush();
    expect(bed.called("terminal.detach")).toEqual([{ method: "terminal.detach", params: { streamId: 1 } }]);
    bed.output(1, 0, "zz");
    expect(bed.sink.output).not.toHaveBeenCalled();
    expect(handle.input(new Uint8Array([1]))).toBe(false);
  });

  it("resize goes to terminal.resize", async () => {
    const { bed, handle } = await opened();
    handle.resize(100, 30);
    await flush();
    expect(bed.called("terminal.resize")).toEqual([
      { method: "terminal.resize", params: { terminalId: TERMINAL_ID, cols: 100, rows: 30 } },
    ]);
  });
});

describe("terminal channel flow control (MC27)", () => {
  it("acks the written offset every 64 KiB and when the write queue empties, not on every frame", async () => {
    const { bed } = await opened({ manualWrites: true });
    for (let index = 0; index < 5; index++) bed.output(1, index * 16 * KIB, 16 * KIB);
    expect(bed.acks()).toEqual([]);
    await bed.finishWrites(3);
    expect(bed.acks()).toEqual([]);
    await bed.finishWrites(1);
    expect(bed.acks()).toEqual([64 * KIB]);
    await bed.finishWrites(1);
    expect(bed.acks()).toEqual([64 * KIB, 80 * KIB]);
  });

  it("acks from the offset of the first frame, not the attach answer's start", async () => {
    const bed = terminalBed();
    bed.handlers["terminal.attach"] = () => ({
      streamId: 1,
      start: 0,
      end: 100,
      cols: 80,
      rows: 24,
      status: "running",
    });
    bed.channel.open(TERMINAL_ID, bed.sink);
    await flush();
    bed.output(1, 40, 10);
    await flush();
    expect(bed.acks()).toEqual([50]);
  });

  it("acks go out as empty ack frames on the stream", async () => {
    const { bed } = await opened();
    bed.output(1, 0, 8);
    await flush();
    const frame = decodeFrame(bed.fake.sentBinary[0] as Uint8Array, CLIENT_OPS);
    expect(frame).toMatchObject({ op: FRAME_OPS.ack, streamId: 1, seq: 8 });
    expect(frame?.payload.byteLength).toBe(0);
  });

  it("a sink write that fails still counts as written, so the server is not stalled", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const bed = terminalBed();
    bed.sink.output.mockImplementation(() => Promise.reject(new Error("boom")));
    bed.channel.open(TERMINAL_ID, bed.sink);
    await flush();
    bed.output(1, 0, 4);
    await flush();
    expect(bed.acks()).toEqual([4]);
    expect(logged).toHaveBeenCalledOnce();
  });
});

describe("terminal channel reconnects", () => {
  it("a write that finishes after a reset does not move the written offset", async () => {
    const { bed } = await opened({ manualWrites: true });
    bed.output(1, 1000, 10);
    bed.reset(1, 200);
    await bed.finishWrites(1);
    bed.fake.setState("waiting");
    bed.fake.setState("open");
    await flush();
    expect(bed.called("terminal.attach").at(-1)?.params).toEqual({ terminalId: TERMINAL_ID, after: 200 });
  });

  it("goes offline on a drop and attaches again with the written offset", async () => {
    const { bed } = await opened();
    bed.output(1, 0, 10);
    await flush();
    bed.fake.setState("waiting");
    expect(bed.sink.state).toHaveBeenLastCalledWith("offline");
    bed.fake.setState("open");
    await flush();
    expect(bed.called("terminal.attach").map((call) => call.params)).toEqual([
      { terminalId: TERMINAL_ID },
      { terminalId: TERMINAL_ID, after: 10 },
    ]);
    expect(bed.sink.state).toHaveBeenLastCalledWith("live");
  });

  it("waits for writes still in flight before it names the offset", async () => {
    const { bed } = await opened({ manualWrites: true });
    bed.output(1, 0, 10);
    bed.fake.setState("waiting");
    bed.fake.setState("open");
    await flush();
    expect(bed.called("terminal.attach")).toHaveLength(1);
    await bed.finishWrites(1);
    await flush();
    expect(bed.called("terminal.attach").at(-1)?.params).toEqual({ terminalId: TERMINAL_ID, after: 10 });
  });

  it("ignores an attach answer from before the drop, and detaches nothing on the new socket", async () => {
    const bed = terminalBed();
    let answer: (value: unknown) => void = () => {};
    bed.handlers["terminal.attach"] = () => new Promise((resolve) => (answer = resolve));
    bed.channel.open(TERMINAL_ID, bed.sink);
    await flush();
    bed.fake.setState("waiting");
    answer({ streamId: 7, start: 0, end: 0, cols: 80, rows: 24, status: "running" });
    await flush();
    expect(bed.sink.attached).not.toHaveBeenCalled();
    expect(bed.called("terminal.detach")).toEqual([]);
    bed.output(7, 0, 5);
    expect(bed.sink.output).not.toHaveBeenCalled();
  });

  it("restarts input numbering at 1 on a new stream", async () => {
    const { bed, handle } = await opened();
    expect(handle.input(new Uint8Array([97]))).toBe(true);
    expect(handle.input(new Uint8Array([98]))).toBe(true);
    expect(handle.input(new Uint8Array([99]))).toBe(true);
    bed.fake.setState("waiting");
    bed.fake.setState("open");
    await flush();
    expect(handle.input(new Uint8Array([100]))).toBe(true);
    expect(bed.sentFrames().map((frame) => [frame.streamId, frame.seq])).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
      [2, 1],
    ]);
  });

  it("refuses input while offline", async () => {
    const { bed, handle } = await opened();
    bed.fake.setState("waiting");
    expect(handle.input(new Uint8Array([97]))).toBe(false);
    expect(bed.fake.sentBinary).toEqual([]);
  });
});

describe("terminal channel input (M8R112)", () => {
  it("splits 150 KiB of é into frames of at most 64 KiB, each valid UTF-8, in order", async () => {
    const { bed, handle } = await opened();
    const text = "a" + "é".repeat(75 * KIB);
    const data = new TextEncoder().encode(text);
    expect(handle.input(data)).toBe(true);
    const frames = bed.sentFrames();
    expect(frames).toHaveLength(3);
    expect(frames.map((frame) => frame.seq)).toEqual([1, 2, 3]);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (const frame of frames) {
      expect(frame.op).toBe(FRAME_OPS.input);
      expect(frame.payload.byteLength).toBeLessThanOrEqual(MAX_FRAME_PAYLOAD);
      expect(() => decoder.decode(frame.payload)).not.toThrow();
    }
    expect(frames.map((frame) => decoder.decode(frame.payload)).join("")).toBe(text);
  });

  it("sends a small input as one frame", async () => {
    const { bed, handle } = await opened();
    handle.input(new TextEncoder().encode("ls\r"));
    expect(bed.sentFrames()).toHaveLength(1);
  });
});

describe("terminal channel visibility (M8R111)", () => {
  it("keeps the stream of a page hidden for less than 5 s", async () => {
    const { bed } = await opened();
    bed.setHidden(true);
    bed.advance(4000);
    bed.setHidden(false);
    bed.advance(10_000);
    await flush();
    expect(bed.called("terminal.detach")).toEqual([]);
    expect(bed.called("terminal.attach")).toHaveLength(1);
  });

  it("detaches 5 s after the page is hidden and reattaches from the written offset when it is visible", async () => {
    const { bed, handle } = await opened();
    bed.output(1, 0, 12);
    await flush();
    bed.setHidden(true);
    bed.advance(5000);
    await flush();
    expect(bed.called("terminal.detach")).toEqual([{ method: "terminal.detach", params: { streamId: 1 } }]);
    expect(handle.input(new Uint8Array([97]))).toBe(false);
    bed.output(1, 12, 4);
    expect(bed.sink.output).toHaveBeenCalledTimes(1);
    bed.setHidden(false);
    await flush();
    expect(bed.called("terminal.attach").at(-1)?.params).toEqual({ terminalId: TERMINAL_ID, after: 12 });
    expect(bed.sink.state).toHaveBeenLastCalledWith("live");
  });

  it("a socket that comes back inside the 5 s still detaches 5 s after the page was hidden", async () => {
    const { bed } = await opened();
    bed.fake.setState("waiting");
    bed.setHidden(true);
    bed.advance(1000);
    bed.fake.setState("open");
    await flush();
    expect(bed.called("terminal.attach")).toHaveLength(2);
    bed.advance(4000);
    await flush();
    expect(bed.called("terminal.detach")).toEqual([{ method: "terminal.detach", params: { streamId: 2 } }]);
  });

  it("a page hidden for 5 s while the socket is down is not attached again until it is visible", async () => {
    const { bed } = await opened();
    bed.fake.setState("waiting");
    bed.setHidden(true);
    bed.advance(5000);
    bed.fake.setState("open");
    await flush();
    expect(bed.called("terminal.attach")).toHaveLength(1);
    bed.setHidden(false);
    await flush();
    expect(bed.called("terminal.attach")).toHaveLength(2);
  });

  it("close clears the hide timer", async () => {
    const { bed, handle } = await opened();
    bed.setHidden(true);
    handle.close();
    await flush();
    bed.advance(5000);
    await flush();
    expect(bed.called("terminal.detach")).toHaveLength(1);
  });
});
