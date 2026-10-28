// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { mount } from "../testing/dom.ts";

const fakes = vi.hoisted(() => ({
  terminals: [] as Array<{ pasted: string[]; modes: { bracketedPasteMode: boolean } }>,
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@xterm/xterm", () => {
  class Terminal {
    cols = 80;
    rows = 24;
    pasted: string[] = [];
    modes = { bracketedPasteMode: false };
    constructor() {
      fakes.terminals.push(this);
    }
    open(): void {}
    loadAddon(): void {}
    onData() {
      return { dispose() {} };
    }
    onBinary() {
      return { dispose() {} };
    }
    attachCustomKeyEventHandler(): void {}
    paste(text: string): void {
      this.pasted.push(text);
    }
    dispose(): void {}
  }
  return { Terminal };
});
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
  },
}));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: vi.fn() }));

import { TerminalSurface, type TerminalScreen } from "./TerminalSurface.tsx";

async function screenOfSurface(): Promise<TerminalScreen> {
  let screen: TerminalScreen | null = null;
  await mount(
    createElement(TerminalSurface, {
      label: "Terminal",
      onScreen: (next: TerminalScreen | null) => {
        screen = next ?? screen;
      },
      onData: () => {},
      onBinary: () => {},
      onResize: () => {},
      onLeave: () => {},
    }),
  );
  if (!screen) throw new Error("no screen");
  return screen;
}

beforeEach(() => {
  fakes.terminals.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("TerminalScreen paste", () => {
  it("paste hands the exact text to term.paste", async () => {
    const screen = await screenOfSurface();
    screen.paste("echo a\necho b");
    expect(fakes.terminals.at(-1)?.pasted).toEqual(["echo a\necho b"]);
  });

  it("bracketedPaste reads term.modes.bracketedPasteMode", async () => {
    const screen = await screenOfSurface();
    expect(screen.bracketedPaste()).toBe(false);
    const term = fakes.terminals.at(-1);
    if (term) term.modes.bracketedPasteMode = true;
    expect(screen.bracketedPaste()).toBe(true);
  });
});
