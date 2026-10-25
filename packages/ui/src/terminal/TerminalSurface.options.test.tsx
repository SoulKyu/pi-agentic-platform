// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { mount } from "../testing/dom.ts";

const seen = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>> }));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      seen.options.push(options);
    }
    loadAddon() {}
    open() {}
    onData() {
      return { dispose() {} };
    }
    onBinary() {
      return { dispose() {} };
    }
    attachCustomKeyEventHandler() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
    dispose(): void {}
  },
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    constructor() {
      throw new Error("no webgl");
    }
    dispose(): void {}
  },
}));

import { TerminalSurface } from "./TerminalSurface.tsx";

let style: HTMLStyleElement | undefined;
beforeEach(() => {
  seen.options.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  style = document.createElement("style");
  style.textContent =
    '[data-terminal-input] { --font-code: "Plex Mono", monospace; --font-mono: var(--font-code); }';
  document.head.append(style);
});
afterEach(() => {
  vi.unstubAllGlobals();
  style?.remove();
});

describe("TerminalSurface options", () => {
  it("xterm gets minimumContrastRatio 4.5 and the --font-code family", async () => {
    await mount(
      createElement(TerminalSurface, {
        label: "Terminal",
        onScreen: vi.fn(),
        onData: vi.fn(),
        onBinary: vi.fn(),
        onResize: vi.fn(),
        onLeave: vi.fn(),
      }),
    );
    const options = seen.options.at(-1);
    expect(options?.minimumContrastRatio).toBe(4.5);
    expect(options?.fontFamily).toBe('"Plex Mono", monospace');
  });
});
