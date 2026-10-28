import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/rpc.ts";
import { flush } from "../../runtime/testing.ts";
import { TERMINAL_ID, terminalBed } from "../../testing/terminal-bed.ts";
import { createTerminalController } from "./use-terminal.ts";
import { MAX_BUSY_ATTEMPTS } from "./terminal.vm.ts";

const screen = () => ({
  write: vi.fn(() => Promise.resolve()),
  reset: vi.fn(),
  focus: vi.fn(),
  paste: vi.fn(),
  bracketedPaste: () => false,
});

afterEach(() => vi.restoreAllMocks());

describe("busy (MC31 m2)", () => {
  const refuse = (bed: ReturnType<typeof terminalBed>) => {
    bed.handlers["terminal.attach"] = () => {
      throw new RpcError("capacity");
    };
  };

  it("shows busy, not offline, and does not ask again by itself", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bed = terminalBed();
    const { controller } = setupOn(bed);
    await flush();
    bed.fake.setState("waiting");
    refuse(bed);
    bed.fake.setState("open");
    await flush();
    expect(controller.view().phase).toBe("busy");
    bed.advance(120_000);
    await flush();
    expect(bed.called("terminal.attach")).toHaveLength(2);
    expect(controller.view().phase).toBe("busy");
  });

  it("asks again, after a backoff, when a running terminal frees its slot", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bed = terminalBed();
    refuse(bed);
    const harness = setupOn(bed);
    await flush();
    expect(harness.controller.view().phase).toBe("busy");
    harness.running(8);
    harness.running(7);
    bed.advance(100);
    await flush();
    expect(bed.called("terminal.attach")).toHaveLength(1);
    delete bed.handlers["terminal.attach"];
    bed.advance(60_000);
    await flush();
    expect(bed.called("terminal.attach")).toHaveLength(2);
    expect(harness.controller.view().phase).toBe("live");
  });

  it("a count that does not drop starts nothing; two drops in a row make one retry", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bed = terminalBed();
    refuse(bed);
    const harness = setupOn(bed);
    await flush();
    harness.running(8);
    harness.running(8);
    harness.running(9);
    bed.advance(60_000);
    await flush();
    expect(bed.called("terminal.attach")).toHaveLength(1);
    harness.running(8);
    harness.running(7);
    bed.advance(60_000);
    await flush();
    expect(bed.called("terminal.attach")).toHaveLength(2);
  });

  it("gives up after the cap, offers a manual retry, and that retry works", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bed = terminalBed();
    refuse(bed);
    const harness = setupOn(bed);
    await flush();
    let count = 100;
    for (let attempt = 0; attempt < MAX_BUSY_ATTEMPTS + 3; attempt++) {
      harness.running(count--);
      bed.advance(60_000);
      await flush();
    }
    expect(bed.called("terminal.attach")).toHaveLength(1 + MAX_BUSY_ATTEMPTS);
    expect(harness.controller.view()).toMatchObject({ phase: "busy", busyExhausted: true });
    delete bed.handlers["terminal.attach"];
    harness.controller.retry();
    await flush();
    expect(harness.controller.view()).toMatchObject({ phase: "live", busyExhausted: false });
  });

  it("stops listening and clears the timer when disposed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bed = terminalBed();
    refuse(bed);
    const harness = setupOn(bed);
    await flush();
    harness.running(5);
    harness.running(4);
    harness.controller.dispose();
    expect(harness.watchers.size).toBe(0);
    bed.advance(60_000);
    await flush();
    expect(bed.called("terminal.attach")).toHaveLength(1);
  });
});

describe("dispose", () => {
  it("closes the channel handle: StrictMode's second controller gets the stream", async () => {
    const bed = terminalBed();
    bed.holdAttaches();
    const make = () =>
      createTerminalController({
        id: TERMINAL_ID,
        channel: bed.channel,
        timers: bed.timers,
        watchRunning: () => () => {},
        closeTerminal: () => Promise.resolve(),
        onChange: () => {},
      });
    make().dispose();
    const second = make();
    second.setScreen(screen());
    await bed.release();
    expect(second.view().phase).toBe("live");
    expect(bed.called("terminal.attach")).toHaveLength(1);
  });
});

function setupOn(bed: ReturnType<typeof terminalBed>) {
  const watchers = new Set<(running: number) => void>();
  const controller = createTerminalController({
    id: TERMINAL_ID,
    channel: bed.channel,
    timers: bed.timers,
    watchRunning: (listener) => {
      watchers.add(listener);
      return () => {
        watchers.delete(listener);
      };
    },
    closeTerminal: () => Promise.resolve(),
    onChange: () => {},
  });
  controller.setScreen(screen());
  return {
    controller,
    watchers,
    running: (count: number) => {
      for (const listener of [...watchers]) listener(count);
    },
  };
}
