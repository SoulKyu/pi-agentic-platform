import { afterEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_ID, terminalBed } from "../testing/terminal-bed.ts";
import { flush } from "./testing.ts";

afterEach(() => vi.restoreAllMocks());

describe("a socket reconnect while an attach is in flight", () => {
  it("drops the answer of the old socket without detaching, and serves the terminal from the new attach", async () => {
    const bed = terminalBed();
    bed.holdAttaches();
    bed.channel.open(TERMINAL_ID, bed.sink);
    await flush();
    bed.fake.setState("waiting");
    expect(bed.sink.state).toHaveBeenLastCalledWith("offline");
    bed.fake.setState("open");
    await flush();
    expect(bed.called("terminal.attach")).toHaveLength(2);
    await bed.release();
    // The stream ids of the old socket mean nothing on the new one: no detach for the stale answer.
    expect(bed.called("terminal.detach")).toEqual([]);
    expect(bed.sink.attached).toHaveBeenCalledOnce();
    expect(bed.sink.state).toHaveBeenLastCalledWith("live");
    bed.output(2, 0, "hi");
    expect(bed.sink.output).toHaveBeenCalledOnce();
  });

  it("a stream id of the old socket delivers nothing on the new one", async () => {
    const bed = terminalBed();
    bed.channel.open(TERMINAL_ID, bed.sink);
    await flush();
    bed.holdAttaches();
    bed.fake.setState("waiting");
    bed.fake.setState("open");
    await flush();
    bed.output(1, 0, "stale");
    expect(bed.sink.output).not.toHaveBeenCalled();
    await bed.release();
    expect(bed.sink.attached).toHaveBeenCalledTimes(2);
  });
});

describe("an attach answer arriving while the page is hidden", () => {
  it("before the 5 s are over: the stream is kept, then released when they pass", async () => {
    const bed = terminalBed();
    bed.holdAttaches();
    bed.channel.open(TERMINAL_ID, bed.sink);
    bed.setHidden(true);
    bed.advance(2000);
    await bed.release();
    expect(bed.sink.attached).toHaveBeenCalledOnce();
    expect(bed.called("terminal.detach")).toEqual([]);
    bed.advance(3000);
    expect(bed.called("terminal.detach")).toEqual([{ method: "terminal.detach", params: { streamId: 1 } }]);
  });

  it("after the 5 s: the answer's stream is released at once and the sink never sees it", async () => {
    const bed = terminalBed();
    bed.holdAttaches();
    bed.channel.open(TERMINAL_ID, bed.sink);
    bed.setHidden(true);
    bed.advance(5000);
    await bed.release();
    expect(bed.called("terminal.detach")).toEqual([{ method: "terminal.detach", params: { streamId: 1 } }]);
    expect(bed.sink.attached).not.toHaveBeenCalled();
    // Visible again: one fresh attach, and its stream serves the sink.
    bed.setHidden(false);
    await flush();
    expect(bed.called("terminal.attach")).toHaveLength(2);
    expect(bed.sink.attached).toHaveBeenCalledOnce();
    expect(bed.sink.state).toHaveBeenLastCalledWith("live");
  });
});
