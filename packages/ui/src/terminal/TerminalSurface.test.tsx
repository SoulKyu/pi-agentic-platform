// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, createElement } from "react";
import { mount } from "../testing/dom.ts";

const fakes = vi.hoisted(() => {
  const state = {
    terminals: [] as Array<Record<string, unknown>>,
    webglThrows: false,
    loadThrows: false,
    webgl: [] as Array<{ disposed: boolean; lose(): void }>,
    loaded: [] as string[],
    context: true,
  };
  return state;
});

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@xterm/xterm", () => {
  class Terminal {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    disposed = false;
    written: Array<{ data: unknown; done?: () => void }> = [];
    resets = 0;
    blurred = 0;
    focused = 0;
    keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
    dataHandler: ((data: string) => void) | null = null;
    binaryHandler: ((data: string) => void) | null = null;
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      fakes.terminals.push(this as unknown as Record<string, unknown>);
    }
    open(): void {}
    loadAddon(addon: { name?: string }): void {
      if (fakes.loadThrows && addon.name === "webgl") throw new Error("webgl init failed");
      fakes.loaded.push(addon.name ?? "fit");
    }
    onData(handler: (data: string) => void) {
      this.dataHandler = handler;
      return { dispose() {} };
    }
    onBinary(handler: (data: string) => void) {
      this.binaryHandler = handler;
      return { dispose() {} };
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      this.keyHandler = handler;
    }
    write(data: unknown, done?: () => void) {
      this.written.push({ data, ...(done ? { done } : {}) });
    }
    reset() {
      this.resets++;
    }
    focus() {
      this.focused++;
    }
    blur() {
      this.blurred++;
    }
    dispose() {
      this.disposed = true;
    }
  }
  return { Terminal };
});
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    name = "fit";
    fit(): void {}
    dispose(): void {}
  },
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    name = "webgl";
    disposed = false;
    #loss: (() => void) | null = null;
    constructor() {
      if (fakes.webglThrows) throw new Error("no webgl");
      fakes.webgl.push({ disposed: false, lose: () => this.#loss?.() });
    }
    onContextLoss(handler: () => void) {
      this.#loss = handler;
      return { dispose() {} };
    }
    dispose() {
      this.disposed = true;
      const mine = fakes.webgl.at(-1);
      if (mine) mine.disposed = true;
    }
  },
}));

import { TerminalSurface, type TerminalScreen } from "./TerminalSurface.tsx";

const observers: Array<() => void> = [];

interface FakeTerminal {
  options: { theme?: unknown; linkHandler?: { activate(event: MouseEvent, uri: string): void } };
  write(data: unknown, done?: () => void): void;
  written: Array<{ data: unknown; done?: () => void }>;
  resets: number;
  blurred: number;
  disposed: boolean;
  keyHandler: ((event: KeyboardEvent) => boolean) | null;
  dataHandler: ((data: string) => void) | null;
  binaryHandler: ((data: string) => void) | null;
}
const term = () => fakes.terminals.at(-1) as unknown as FakeTerminal;

function surface() {
  const props = {
    label: "Terminal",
    onScreen: vi.fn<(screen: TerminalScreen | null) => void>(),
    onData: vi.fn<(data: string) => void>(),
    onBinary: vi.fn<(data: string) => void>(),
    onResize: vi.fn<(cols: number, rows: number) => void>(),
    onLeave: vi.fn<() => void>(),
  };
  return { props, element: createElement(TerminalSurface, props) };
}
const screenOf = (props: { onScreen: Mock<(screen: TerminalScreen | null) => void> }): TerminalScreen => {
  const screen = props.onScreen.mock.calls.find((call) => call[0] !== null)?.[0];
  if (!screen) throw new Error("no screen was given");
  return screen;
};

beforeEach(() => {
  fakes.terminals.length = 0;
  fakes.webgl.length = 0;
  fakes.loaded.length = 0;
  fakes.webglThrows = false;
  fakes.loadThrows = false;
  observers.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  vi.stubGlobal("WebGL2RenderingContext", function WebGL2RenderingContext() {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TerminalSurface", () => {
  it("marks its root so pap's chords and Escape stay out", async () => {
    const { element } = surface();
    const page = await mount(element);
    const root = page.container.querySelector("[data-terminal-input]");
    expect(root).not.toBeNull();
    expect(root?.getAttribute("role")).toBe("group");
    expect(root?.getAttribute("aria-label")).toBe("Terminal");
  });

  it("Ctrl+] leaves the terminal: xterm does not get the key, the owner is told, the focus goes", async () => {
    const { element, props } = surface();
    await mount(element);
    const press = (init: KeyboardEventInit) => term().keyHandler?.(new KeyboardEvent("keydown", init));
    expect(press({ key: "]", ctrlKey: true })).toBe(false);
    expect(props.onLeave).toHaveBeenCalledOnce();
    expect(term().blurred).toBe(1);
    expect(press({ key: "]" })).toBe(true);
    expect(press({ key: "a", ctrlKey: true })).toBe(true);
    expect(props.onLeave).toHaveBeenCalledOnce();
  });

  it("re-applies the theme once per data-theme change", async () => {
    const { element } = surface();
    await mount(element);
    const first = term().options.theme;
    expect(first).toBeDefined();
    await act(async () => {
      document.documentElement.setAttribute("data-theme", "day");
      await Promise.resolve();
    });
    const second = term().options.theme;
    expect(second).not.toBe(first);
    await act(async () => {
      await Promise.resolve();
    });
    expect(term().options.theme).toBe(second);
    document.documentElement.removeAttribute("data-theme");
  });

  it("opens only http and https links, with noopener and noreferrer", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { element } = surface();
    await mount(element);
    const activate = term().options.linkHandler?.activate;
    expect(activate).toBeDefined();
    for (const uri of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,x",
      "not a url",
      "ftp://x.test/a",
    ])
      activate?.(new MouseEvent("click"), uri);
    expect(open).not.toHaveBeenCalled();
    activate?.(new MouseEvent("click"), "https://x.test");
    expect(open).toHaveBeenCalledExactlyOnceWith("https://x.test/", "_blank", "noopener,noreferrer");
    activate?.(new MouseEvent("click"), "http://y.test/a?b=1");
    expect(open).toHaveBeenLastCalledWith("http://y.test/a?b=1", "_blank", "noopener,noreferrer");
  });

  it("loads the fit and WebGL addons only: never a clipboard addon", async () => {
    const { element } = surface();
    await mount(element);
    expect(fakes.loaded.sort()).toEqual(["fit", "webgl"]);
  });

  it("falls back to the DOM renderer when WebGL is missing or fails", async () => {
    vi.stubGlobal("WebGL2RenderingContext", undefined);
    const first = surface();
    await mount(first.element);
    expect(fakes.loaded).toEqual(["fit"]);
    vi.stubGlobal("WebGL2RenderingContext", function WebGL2RenderingContext() {});
    fakes.webglThrows = true;
    fakes.loaded.length = 0;
    const second = surface();
    await mount(second.element);
    expect(fakes.loaded).toEqual(["fit"]);
  });

  it("falls back to the DOM renderer when the WebGL addon fails to activate, and the pane still works", async () => {
    fakes.loadThrows = true;
    const { element, props } = surface();
    await mount(element);
    expect(fakes.loaded).toEqual(["fit"]);
    expect(fakes.webgl[0]?.disposed).toBe(true);
    expect(screenOf(props)).toBeDefined();
    term().dataHandler?.("ls");
    expect(props.onData).toHaveBeenCalledWith("ls");
  });

  it("disposes the WebGL addon on a context loss", async () => {
    const { element } = surface();
    await mount(element);
    expect(fakes.webgl[0]?.disposed).toBe(false);
    fakes.webgl[0]?.lose();
    expect(fakes.webgl[0]?.disposed).toBe(true);
  });

  it("forwards typing, binary replies and its own size", async () => {
    const { element, props } = surface();
    await mount(element);
    term().dataHandler?.("ls\r");
    term().binaryHandler?.("ÿ");
    expect(props.onData).toHaveBeenCalledWith("ls\r");
    expect(props.onBinary).toHaveBeenCalledWith("ÿ");
    expect(props.onResize).toHaveBeenCalledExactlyOnceWith(80, 24);
  });

  it("reports a size only when its own container changes it, and only if it differs", async () => {
    const { element, props } = surface();
    await mount(element);
    expect(props.onResize).toHaveBeenCalledTimes(1);
    const fake = term() as unknown as { cols: number };
    fake.cols = 100;
    observers[0]?.();
    expect(props.onResize).toHaveBeenLastCalledWith(100, 24);
    observers[0]?.();
    expect(props.onResize).toHaveBeenCalledTimes(2);
  });

  describe("the screen", () => {
    it("writes bytes and settles when xterm calls back", async () => {
      const { element, props } = surface();
      await mount(element);
      const screen = screenOf(props);
      let settled = false;
      const done = screen.write(new Uint8Array([104, 105])).then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      term().written[0]?.done?.();
      await done;
      expect(settled).toBe(true);
    });

    it("orders reset after the writes queued before it (MC31 m1)", async () => {
      const { element, props } = surface();
      await mount(element);
      const screen = screenOf(props);
      void screen.write(new Uint8Array([1]));
      screen.reset();
      expect(term().resets).toBe(0);
      term().written[0]?.done?.();
      expect(term().resets).toBe(0);
      term().written[1]?.done?.();
      expect(term().resets).toBe(1);
    });

    it("settles every pending write when the surface unmounts (MC31 m1)", async () => {
      const { element, props } = surface();
      const page = await mount(element);
      const screen = screenOf(props);
      const pending = [screen.write(new Uint8Array([1])), screen.write(new Uint8Array([2]))];
      await page.unmount();
      await expect(Promise.all(pending)).resolves.toEqual([undefined, undefined]);
      expect(term().disposed).toBe(true);
      expect(props.onScreen).toHaveBeenLastCalledWith(null);
      await expect(screen.write(new Uint8Array([3]))).resolves.toBeUndefined();
      expect(term().resets).toBe(0);
    });

    it("does not reset a disposed terminal when a queued reset fires late", async () => {
      const { element, props } = surface();
      const page = await mount(element);
      const screen = screenOf(props);
      screen.reset();
      await page.unmount();
      term().written[0]?.done?.();
      expect(term().resets).toBe(0);
    });

    it("rejects a write xterm refuses, so the channel can count it", async () => {
      const { element, props } = surface();
      await mount(element);
      term().write = () => {
        throw new Error("write data discarded");
      };
      await expect(screenOf(props).write(new Uint8Array([1]))).rejects.toThrow("write data discarded");
    });
  });
});
