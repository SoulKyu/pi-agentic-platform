import { describe, expect, it, vi } from "vitest";
import type { TerminalChannel, TerminalHandle, TerminalSink } from "../../runtime/terminal-types.ts";
import { createTerminalController } from "./use-terminal.ts";

const ESC = String.fromCharCode(27);
const decoder = new TextDecoder();

/** A channel that records the bytes the controller sends and keeps the sink to drive. */
function fakeChannel() {
  const sent: string[] = [];
  const state: { sink: TerminalSink | null } = { sink: null };
  const handle: TerminalHandle = {
    input(data) {
      sent.push(decoder.decode(data));
      return true;
    },
    resize() {},
    close() {},
  };
  const channel: TerminalChannel = {
    open(_id, sink) {
      state.sink = sink;
      return handle;
    },
  };
  return { channel, sent, sink: () => state.sink as TerminalSink };
}

/** A screen whose paste follows xterm's documented transform and feeds the surface's onData. */
function fakeScreen(options: { bracketed: boolean }) {
  const mode = { bracketed: options.bracketed };
  const calls: string[] = [];
  const feed: { onData: (data: string) => void } = { onData: () => {} };
  const screen = {
    write: vi.fn(() => Promise.resolve()),
    reset: vi.fn(),
    focus: vi.fn(() => void calls.push("focus")),
    paste(text: string) {
      calls.push("paste");
      const normalised = text.replace(/\r?\n/g, "\r");
      feed.onData(mode.bracketed ? `${ESC}[200~${normalised}${ESC}[201~` : normalised);
    },
    bracketedPaste: () => mode.bracketed,
  };
  return { screen, mode, calls, feed };
}

function setup(options: { bracketed?: boolean; replay?: number } = {}) {
  const { channel, sent, sink } = fakeChannel();
  const views: boolean[] = [];
  const controller = createTerminalController({
    id: "t1",
    channel,
    timers: { set: () => 1, clear: () => {} },
    watchRunning: () => () => {},
    closeTerminal: () => Promise.resolve(),
    onChange: (view) => views.push(view.typing),
  });
  const fake = fakeScreen({ bracketed: options.bracketed ?? true });
  fake.feed.onData = (data) => controller.input(data);
  controller.setScreen(fake.screen);
  const attach = (end = 0) => {
    sink().attached({ start: 0, end, cols: 80, rows: 24, status: "running" });
    sink().state("live");
  };
  return { controller, sent, sink, fake, attach, views };
}

describe("handOff", () => {
  it("a single line is typed as exactly its bytes, with no CR or LF", () => {
    const { controller, sent, attach } = setup({ bracketed: false });
    attach();
    expect(controller.handOff("touch ux1-one")).toBe("typed");
    expect(sent.join("")).toBe("touch ux1-one");
    expect(sent.join("")).not.toMatch(/[\r\n]/);
  });

  it("two lines with bracketed paste on are typed as ESC[200~a CR b ESC[201~ and nothing after the end marker", () => {
    const { controller, sent, fake, attach } = setup({ bracketed: true });
    attach();
    expect(controller.handOff("a\nb")).toBe("typed");
    expect(sent.join("")).toBe(`${ESC}[200~a\rb${ESC}[201~`);
    expect(fake.calls).toEqual(["paste", "focus"]);
  });

  it("two lines with bracketed paste off type nothing and answer multiline", () => {
    const { controller, sent, fake, attach } = setup({ bracketed: false });
    attach();
    expect(controller.handOff("a\nb")).toBe("multiline");
    expect(sent).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("before the replay is written handOff answers not_ready and types nothing", async () => {
    const { controller, sent, sink, attach } = setup();
    attach(10);
    expect(controller.handOff("ls")).toBe("not_ready");
    expect(sent).toEqual([]);
    await sink().output(new Uint8Array(10), 10);
    expect(controller.handOff("ls")).toBe("typed");
    expect(sent.join("")).toBe(`${ESC}[200~ls${ESC}[201~`);
  });

  it("typing turns true only when live, replayed and a screen is set, and false again on offline", async () => {
    const { controller, sink, views } = setup();
    expect(controller.view().typing).toBe(false);
    sink().attached({ start: 0, end: 4, cols: 80, rows: 24, status: "running" });
    sink().state("live");
    expect(controller.view().typing).toBe(false);
    await sink().output(new Uint8Array(4), 4);
    expect(controller.view().typing).toBe(true);
    sink().state("offline");
    expect(controller.view().typing).toBe(false);
    sink().state("live");
    expect(controller.view().typing).toBe(true);
    controller.setScreen(null);
    expect(controller.view().typing).toBe(false);
    expect(views).toContain(true);
  });
});
