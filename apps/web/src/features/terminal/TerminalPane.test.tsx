// @vitest-environment happy-dom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/rpc.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useTerminalStore } from "../../stores/terminal-store.ts";
import { click, mount, settle } from "../../testing/dom.ts";
import { terminalView } from "../../testing/m8-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { TERMINAL_ID, terminalBed } from "../../testing/terminal-bed.ts";

const current = vi.hoisted(() => ({
  runtime: undefined as Runtime | undefined,
  channel: undefined as unknown,
  surface: undefined as
    | undefined
    | {
        onScreen(screen: unknown): void;
        onLeave(): void;
        onData(data: string): void;
        onResize(c: number, r: number): void;
      },
}));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../../runtime/terminal-channel.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/terminal-channel.ts")>()),
  getTerminalChannel: () => current.channel,
}));
vi.mock("@pap/ui/terminal", async () => {
  const { createElement: h } = await import("react");
  return {
    TerminalSurface: (props: NonNullable<typeof current.surface> & { label: string }) => {
      current.surface = props;
      return h("div", { "data-fake-surface": props.label });
    },
  };
});

import { TerminalPane } from "./TerminalPane.tsx";

function setup() {
  const runtime = fakeRuntime("open");
  current.runtime = runtime.runtime;
  const bed = terminalBed();
  current.channel = bed.channel;
  const onClose = vi.fn();
  const onOpen = vi.fn();
  const pane = () => createElement(TerminalPane, { id: TERMINAL_ID, onClose, onOpen });
  return { runtime, bed, onClose, onOpen, pane };
}
const text = (container: HTMLElement) => container.textContent ?? "";
const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button")].find(
    (one) => one.textContent?.trim() === label,
  ) as HTMLButtonElement;

beforeEach(() => {
  useTerminalStore.getState().reset();
  current.surface = undefined;
  useTerminalStore.getState().apply({
    kind: "snapshot",
    terminals: [terminalView(1, { id: TERMINAL_ID, cwd: "/home/ana/api" })],
  });
});
afterEach(() => vi.restoreAllMocks());

describe("TerminalPane", () => {
  it("shows the surface with the folder name and no banner while live", async () => {
    const { bed, pane } = setup();
    const page = await mount(pane());
    await settle();
    expect(page.container.querySelector("[data-terminal-pane]")).not.toBeNull();
    expect(page.container.querySelector("[data-fake-surface]")).not.toBeNull();
    expect(text(page.container)).toContain("api");
    expect(page.container.querySelector("[data-slot='banner']")).toBeNull();
    expect(bed.called("terminal.attach")).toHaveLength(1);
  });

  it("says input is paused while reconnecting", async () => {
    const { bed, pane } = setup();
    const page = await mount(pane());
    await settle();
    bed.fake.setState("waiting");
    await settle();
    expect(text(page.container)).toContain("Reconnecting… input paused");
  });

  it("says all slots are busy, apart from offline", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { bed, pane } = setup();
    bed.handlers["terminal.attach"] = () => {
      throw new RpcError("capacity");
    };
    const page = await mount(pane());
    await settle();
    expect(text(page.container)).toContain("Too many terminals are running");
    expect(text(page.container)).not.toContain("Reconnecting");
  });

  it("says a process exited, with its code, and offers Close and New terminal here", async () => {
    const { bed, pane, onClose, runtime, onOpen } = setup();
    const page = await mount(pane());
    await settle();
    bed.exit(1, 0, 3, null);
    await settle();
    expect(text(page.container)).toContain("Process exited (code 3)");
    runtime.handlers["terminal.create"] = () => ({ terminalId: "NEWNEWNEWNEWNEWNEWNEWN" });
    await click(button(page.container, "New terminal here"));
    await settle();
    expect(runtime.called("terminal.create")[0]?.params).toMatchObject({
      cwd: "/home/ana/api",
      cols: 80,
      rows: 24,
    });
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("NEWNEWNEWNEWNEWNEWNEWN");
    await click(button(page.container, "Close"));
    await settle();
    expect(runtime.called("terminal.close")[0]?.params).toEqual({ terminalId: TERMINAL_ID });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("says a terminal ended when the server forgot it", async () => {
    const { bed, pane } = setup();
    bed.handlers["terminal.attach"] = () => {
      throw new RpcError("not_found");
    };
    const page = await mount(pane());
    await settle();
    expect(text(page.container)).toContain("This terminal ended: pap restarted or it was closed");
    expect(button(page.container, "New terminal here")).toBeDefined();
  });

  it("asks before closing a running terminal", async () => {
    const { pane, runtime, onClose } = setup();
    const page = await mount(pane());
    await settle();
    await click(button(page.container, "Close"));
    expect(text(page.container)).toContain("Close the terminal and stop what runs in it?");
    expect(runtime.called("terminal.close")).toEqual([]);
    await click(button(page.container, "Cancel"));
    expect(text(page.container)).not.toContain("stop what runs in it");
    await click(button(page.container, "Close"));
    const confirm = [...page.container.querySelectorAll("button")].find(
      (one) => one.textContent?.trim() === "Close terminal",
    ) as HTMLButtonElement;
    await click(confirm);
    await settle();
    expect(runtime.called("terminal.close")).toHaveLength(1);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Ctrl+] from the terminal puts the focus on the pane header", async () => {
    const { pane } = setup();
    const page = await mount(pane());
    await settle();
    current.surface?.onLeave();
    expect(document.activeElement).toBe(page.container.querySelector("[data-terminal-header]"));
  });

  it("forwards typing to the stream", async () => {
    const { pane, bed } = setup();
    await mount(pane());
    await settle();
    current.surface?.onScreen({
      write: () => Promise.resolve(),
      reset() {},
      focus() {},
      paste() {},
      bracketedPaste: () => false,
    });
    current.surface?.onData("ls\r");
    expect(bed.sentFrames().at(-1)?.payload).toEqual(new TextEncoder().encode("ls\r"));
  });

  it("a remount before the attach answer (StrictMode) sends one attach, and the second pane gets the stream", async () => {
    const { pane, bed } = setup();
    bed.holdAttaches();
    const first = await mount(pane());
    await first.unmount();
    const second = await mount(pane());
    await bed.release();
    await settle();
    expect(bed.called("terminal.attach")).toHaveLength(1);
    expect(bed.called("terminal.detach")).toEqual([]);
    expect(second.container.querySelector("[data-slot='banner']")).toBeNull();
  });
});
