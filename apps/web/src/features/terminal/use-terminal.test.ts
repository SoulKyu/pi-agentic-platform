import { RpcError } from "../../runtime/rpc.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush } from "../../runtime/testing.ts";
import { useTerminalStore } from "../../stores/terminal-store.ts";
import { TERMINAL_ID, terminalBed } from "../../testing/terminal-bed.ts";
import { terminalView } from "../../testing/m8-fixtures.ts";
import { createTerminalController, watchRunningTerminals } from "./use-terminal.ts";

const attachAnswer = (end: number, status: "running" | "exited" = "running") => ({
  streamId: 1,
  start: 0,
  end,
  cols: 80,
  rows: 24,
  status,
});
const screen = () => ({
  write: vi.fn(() => Promise.resolve()),
  reset: vi.fn(),
  focus: vi.fn(),
});

function setup(
  options: {
    closeTerminal?: () => Promise<void>;
    prepare?: (bed: ReturnType<typeof terminalBed>) => void;
  } = {},
) {
  const bed = terminalBed();
  options.prepare?.(bed);
  const watchers = new Set<(running: number) => void>();
  const closeTerminal = vi.fn(options.closeTerminal ?? (() => Promise.resolve()));
  const changes = vi.fn();
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
    closeTerminal,
    onChange: changes,
  });
  const fakeScreen = screen();
  controller.setScreen(fakeScreen);
  return {
    bed,
    controller,
    fakeScreen,
    closeTerminal,
    changes,
    watchers,
    running: (count: number) => {
      for (const listener of [...watchers]) listener(count);
    },
  };
}

beforeEach(() => useTerminalStore.getState().reset());
afterEach(() => vi.restoreAllMocks());

const typed = (bed: ReturnType<typeof terminalBed>) =>
  bed
    .sentFrames()
    .filter((frame) => frame.payload.byteLength > 0)
    .map((frame) => new TextDecoder().decode(frame.payload));

describe("replay protection (M8R81)", () => {
  it("drops what xterm types before the replay is written, and sends it after", async () => {
    const { bed, controller } = setup({
      prepare: (made) => {
        made.handlers["terminal.attach"] = () => attachAnswer(10);
      },
    });
    await flush();
    controller.input("\u001b[?1;2c");
    controller.binary("ÿ");
    expect(typed(bed)).toEqual([]);
    bed.output(1, 0, 4);
    await flush();
    controller.input("still replaying");
    expect(typed(bed)).toEqual([]);
    bed.output(1, 4, 6);
    await flush();
    controller.input("ls\r");
    expect(typed(bed)).toEqual(["ls\r"]);
  });

  it("a write that fails does not keep the input dropped for good", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { bed, controller, fakeScreen } = setup({
      prepare: (made) => {
        made.handlers["terminal.attach"] = () => attachAnswer(10);
      },
    });
    await flush();
    fakeScreen.write.mockRejectedValueOnce(new Error("discarded"));
    bed.output(1, 0, 10);
    await flush();
    controller.input("ls\r");
    expect(typed(bed)).toEqual(["ls\r"]);
  });

  it("does not hold input back when there is nothing to replay", async () => {
    const { bed, controller } = setup();
    await flush();
    controller.input("ls\r");
    expect(typed(bed)).toEqual(["ls\r"]);
  });

  it("sends binary replies as raw bytes after the replay", async () => {
    const { bed, controller } = setup();
    await flush();
    controller.binary("ÿa");
    const frame = bed.sentFrames().at(-1);
    expect([...(frame?.payload ?? [])]).toEqual([0xff, 0x61]);
  });

  it("holds input again for the replay of a later attach", async () => {
    const { bed, controller } = setup();
    await flush();
    bed.fake.setState("waiting");
    bed.handlers["terminal.attach"] = () => ({ ...attachAnswer(30), streamId: 2 });
    bed.fake.setState("open");
    await flush();
    controller.input("x");
    expect(typed(bed)).toEqual([]);
    bed.output(2, 0, 30);
    await flush();
    controller.input("y");
    expect(typed(bed)).toEqual(["y"]);
  });
});

describe("what the screen is told", () => {
  it("writes output bytes and resets through the screen, and a missing screen never stalls the acks", async () => {
    const { bed, controller, fakeScreen } = setup();
    await flush();
    bed.output(1, 0, "hi");
    expect(fakeScreen.write).toHaveBeenCalledOnce();
    bed.reset(1, 5);
    expect(fakeScreen.reset).toHaveBeenCalledOnce();
    controller.setScreen(null);
    bed.output(1, 5, "more");
    await flush();
    expect(bed.acks().at(-1)).toBe(9);
  });
});

describe("states", () => {
  it("offline pauses the input and says so; a stage label shows after 3 s and goes when live", async () => {
    const { bed, controller } = setup();
    await flush();
    expect(controller.view().phase).toBe("live");
    bed.fake.setState("waiting");
    expect(controller.view()).toMatchObject({ phase: "offline", slow: false });
    controller.input("x");
    expect(typed(bed)).toEqual([]);
    bed.advance(2999);
    expect(controller.view().slow).toBe(false);
    bed.advance(1);
    expect(controller.view().slow).toBe(true);
    bed.fake.setState("open");
    await flush();
    expect(controller.view()).toMatchObject({ phase: "live", slow: false });
  });

  it("exited shows the code", async () => {
    const { bed, controller } = setup();
    await flush();
    bed.exit(1, 0, 3, null);
    await flush();
    expect(controller.view()).toMatchObject({ phase: "exited", exit: { code: 3, signal: null } });
  });

  it("a terminal that is already exited when attached takes its code from the store", async () => {
    useTerminalStore.getState().apply({
      kind: "snapshot",
      terminals: [terminalView(1, { id: TERMINAL_ID, status: "exited", exitCode: 7 })],
    });
    const { controller } = setup({
      prepare: (made) => {
        made.handlers["terminal.attach"] = () => attachAnswer(0, "exited");
      },
    });
    await flush();
    expect(controller.view()).toMatchObject({ phase: "exited", exit: { code: 7, signal: null } });
  });

  it("gone when the server no longer knows the terminal", async () => {
    const { controller } = setup({
      prepare: (made) => {
        made.handlers["terminal.attach"] = () => {
          throw new RpcError("not_found");
        };
      },
    });
    await flush();
    expect(controller.view().phase).toBe("gone");
  });

  it("notifies the view on each change", async () => {
    const { changes } = setup();
    await flush();
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "live" }));
  });
});

describe("close (M8R81)", () => {
  it("asks first on a running terminal, then closes once on confirm", async () => {
    const { controller, closeTerminal } = setup();
    await flush();
    controller.requestClose();
    expect(controller.view().confirmingClose).toBe(true);
    expect(closeTerminal).not.toHaveBeenCalled();
    controller.cancelClose();
    expect(controller.view().confirmingClose).toBe(false);
    controller.requestClose();
    controller.confirmClose();
    controller.confirmClose();
    await flush();
    expect(closeTerminal).toHaveBeenCalledOnce();
  });

  it("closes an exited or gone terminal without asking", async () => {
    const { bed, controller, closeTerminal } = setup();
    await flush();
    bed.exit(1, 0, 0, null);
    await flush();
    controller.requestClose();
    expect(controller.view().confirmingClose).toBe(false);
    expect(closeTerminal).toHaveBeenCalledOnce();
  });

  it("says when the close failed", async () => {
    const { controller } = setup({ closeTerminal: () => Promise.reject(new Error("no")) });
    await flush();
    controller.requestClose();
    controller.confirmClose();
    await flush();
    expect(controller.view()).toMatchObject({ confirmingClose: false, closeFailed: true });
  });
});

describe("size (M8R80, RT-32)", () => {
  it("sends one terminal.resize for the resizes inside 100 ms, with the last size", async () => {
    const { bed, controller } = setup();
    await flush();
    controller.resize(100, 30);
    controller.resize(101, 30);
    controller.resize(102, 31);
    expect(bed.called("terminal.resize")).toEqual([]);
    bed.advance(99);
    expect(bed.called("terminal.resize")).toEqual([]);
    bed.advance(1);
    await flush();
    expect(bed.called("terminal.resize")).toEqual([
      { method: "terminal.resize", params: { terminalId: TERMINAL_ID, cols: 102, rows: 31 } },
    ]);
  });

  it("sends the size asked before the stream was attached once it is", async () => {
    const bed = terminalBed();
    bed.holdAttaches();
    const controller = createTerminalController({
      id: TERMINAL_ID,
      channel: bed.channel,
      timers: bed.timers,
      watchRunning: () => () => {},
      closeTerminal: () => Promise.resolve(),
      onChange: () => {},
    });
    controller.resize(120, 40);
    bed.advance(100);
    await bed.release();
    expect(bed.called("terminal.resize").map((call) => call.params)).toEqual([
      { terminalId: TERMINAL_ID, cols: 120, rows: 40 },
    ]);
  });

  it("another client's size, coming on the terminal stream, resizes nothing", async () => {
    const bed = terminalBed();
    const controller = createTerminalController({
      id: TERMINAL_ID,
      channel: bed.channel,
      timers: bed.timers,
      watchRunning: watchRunningTerminals,
      closeTerminal: () => Promise.resolve(),
      onChange: () => {},
    });
    controller.setScreen(screen());
    await flush();
    useTerminalStore
      .getState()
      .apply({ kind: "snapshot", terminals: [terminalView(1, { id: TERMINAL_ID })] });
    useTerminalStore
      .getState()
      .apply({ kind: "terminal", terminal: terminalView(1, { id: TERMINAL_ID, cols: 200, rows: 50 }) });
    bed.advance(1000);
    await flush();
    controller.dispose();
    expect(bed.called("terminal.resize")).toEqual([]);
  });
});
