import { afterEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_ID, terminalBed } from "../testing/terminal-bed.ts";
import { RpcError } from "./rpc.ts";
import { flush } from "./testing.ts";

afterEach(() => vi.restoreAllMocks());

async function opened() {
  const bed = terminalBed();
  const handle = bed.channel.open(TERMINAL_ID, bed.sink);
  await flush();
  return { bed, handle };
}

describe("one attach in flight per terminal (MC31)", () => {
  it("open, close, open before the answer (StrictMode) sends one attach, and the second pane gets the stream", async () => {
    const bed = terminalBed();
    bed.holdAttaches();
    const first = bed.channel.open(TERMINAL_ID, bed.sink);
    first.close();
    const second = bed.terminalSink();
    const handle = bed.channel.open(TERMINAL_ID, second);
    await bed.release();
    expect(bed.called("terminal.attach")).toHaveLength(1);
    expect(bed.called("terminal.detach")).toEqual([]);
    expect(second.attached).toHaveBeenCalledOnce();
    expect(bed.sink.attached).not.toHaveBeenCalled();
    bed.output(1, 0, "hi");
    expect(second.output).toHaveBeenCalledOnce();
    expect(handle.input(new Uint8Array([97]))).toBe(true);
    expect(bed.sentFrames().at(-1)).toMatchObject({ streamId: 1, seq: 1 });
  });

  it("open then close with no replacement releases the stream the answer brings", async () => {
    const bed = terminalBed();
    bed.holdAttaches();
    bed.channel.open(TERMINAL_ID, bed.sink).close();
    await bed.release();
    expect(bed.called("terminal.detach")).toEqual([{ method: "terminal.detach", params: { streamId: 1 } }]);
    expect(bed.sink.attached).not.toHaveBeenCalled();
  });

  it("hidden for 5 s then visible before the answer keeps the stream and sends no second attach", async () => {
    const bed = terminalBed();
    bed.holdAttaches();
    bed.channel.open(TERMINAL_ID, bed.sink);
    bed.setHidden(true);
    bed.advance(5000);
    bed.setHidden(false);
    await bed.release();
    expect(bed.called("terminal.attach")).toHaveLength(1);
    expect(bed.called("terminal.detach")).toEqual([]);
    expect(bed.sink.attached).toHaveBeenCalledOnce();
    expect(bed.sink.state).toHaveBeenLastCalledWith("live");
  });

  it("an answer asked with another start than the entry needs is released and the terminal is asked again", async () => {
    const bed = terminalBed();
    const first = bed.channel.open(TERMINAL_ID, bed.sink);
    await flush();
    bed.output(1, 0, 10);
    await flush();
    bed.setHidden(true);
    bed.advance(5000);
    bed.holdAttaches();
    bed.setHidden(false);
    first.close();
    const second = bed.terminalSink();
    bed.channel.open(TERMINAL_ID, second);
    await bed.release();
    expect(bed.called("terminal.attach").map((call) => call.params)).toEqual([
      { terminalId: TERMINAL_ID },
      { terminalId: TERMINAL_ID, after: 10 },
      { terminalId: TERMINAL_ID },
    ]);
    expect(bed.called("terminal.detach").map((call) => call.params)).toEqual([
      { streamId: 1 },
      { streamId: 2 },
    ]);
    expect(second.attached).toHaveBeenCalledOnce();
  });
});

describe("terminal channel refusals and size", () => {
  it("a capacity refusal shows busy, not offline, logs once and asks again only on a reconnect (MC31 m2)", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bed = terminalBed();
    bed.handlers["terminal.attach"] = () => {
      throw new RpcError("capacity");
    };
    bed.channel.open(TERMINAL_ID, bed.sink);
    await flush();
    expect(bed.sink.state).toHaveBeenLastCalledWith("busy");
    expect(bed.sink.state).not.toHaveBeenCalledWith("offline");
    expect(warned).toHaveBeenCalledExactlyOnceWith("terminal_attach_failed", "capacity");
    bed.advance(60_000);
    await flush();
    expect(bed.called("terminal.attach")).toHaveLength(1);
    bed.handlers["terminal.attach"] = () => ({
      streamId: 1,
      start: 0,
      end: 0,
      cols: 80,
      rows: 24,
      status: "running",
    });
    bed.fake.setState("waiting");
    bed.fake.setState("open");
    await flush();
    expect(bed.sink.state).toHaveBeenLastCalledWith("live");
  });

  it("a throwing sink callback is logged, not an unhandled rejection", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const bed = terminalBed();
    bed.sink.attached.mockImplementation(() => {
      throw new Error("boom");
    });
    bed.channel.open(TERMINAL_ID, bed.sink);
    await flush();
    expect(logged).toHaveBeenCalledOnce();
  });

  it("resize is clamped to the contract limits and skipped for a pane with no size", async () => {
    const { bed, handle } = await opened();
    handle.resize(0, 0);
    handle.resize(Number.NaN, 24);
    handle.resize(1000, 1);
    await flush();
    expect(bed.called("terminal.resize").map((call) => call.params)).toEqual([
      { terminalId: TERMINAL_ID, cols: 500, rows: 2 },
    ]);
  });

  it("the last size is sent again when a stream is attached and differs", async () => {
    const bed = terminalBed();
    const handle = bed.channel.open(TERMINAL_ID, bed.sink);
    handle.resize(100, 30);
    await flush();
    expect(bed.called("terminal.resize")).toEqual([
      { method: "terminal.resize", params: { terminalId: TERMINAL_ID, cols: 100, rows: 30 } },
    ]);
    bed.fake.setState("waiting");
    bed.fake.setState("open");
    await flush();
    expect(bed.called("terminal.resize")).toHaveLength(2);
  });
});
