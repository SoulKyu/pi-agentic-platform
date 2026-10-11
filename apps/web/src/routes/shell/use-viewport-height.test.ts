// @vitest-environment happy-dom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "../../testing/dom.ts";
import {
  KEYBOARD_MIN_HEIGHT_PX,
  shouldUseVisualViewportHeight,
  useViewportHeight,
} from "./use-viewport-height.ts";

describe("keyboard detection (pw hooks/useViewportHeight.ts)", () => {
  it("needs a focused editor", () => {
    expect(
      shouldUseVisualViewportHeight({
        hasFocusedEditable: false,
        innerHeight: 800,
        viewportHeight: 400,
        viewportScale: 1,
      }),
    ).toBe(false);
  });
  it("ignores toolbar-sized shrinks and accepts keyboard-sized ones", () => {
    expect(
      shouldUseVisualViewportHeight({
        hasFocusedEditable: true,
        innerHeight: 800,
        viewportHeight: 800 - KEYBOARD_MIN_HEIGHT_PX,
        viewportScale: 1,
      }),
    ).toBe(false);
    expect(
      shouldUseVisualViewportHeight({
        hasFocusedEditable: true,
        innerHeight: 800,
        viewportHeight: 500,
        viewportScale: 1,
      }),
    ).toBe(true);
  });
  it("compares against the zoom-corrected height", () => {
    expect(
      shouldUseVisualViewportHeight({
        hasFocusedEditable: true,
        innerHeight: 800,
        viewportHeight: 400,
        viewportScale: 2,
      }),
    ).toBe(false);
    expect(
      shouldUseVisualViewportHeight({
        hasFocusedEditable: true,
        innerHeight: 800,
        viewportHeight: 300,
        viewportScale: 2,
      }),
    ).toBe(true);
  });
});

function Probe() {
  useViewportHeight();
  return null;
}

/** A visualViewport that keeps its listeners where the test can count them. */
function fakeViewport() {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    height: 400,
    scale: 1,
    addEventListener: (type: string, listener: EventListener) => {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
    },
    removeEventListener: (type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener);
    },
    fire: (type: string) => listeners.get(type)?.forEach((listener) => listener(new Event(type))),
    count: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

const EXPECTED_LISTENERS = [
  "window:resize",
  "window:focusin",
  "window:focusout",
  "window:pageshow",
  "document:compositionstart",
  "document:compositionupdate",
  "document:compositionend",
  "document:input",
  "document:keyup",
];

const root = document.documentElement;
const keyboardOpen = () => root.hasAttribute("data-keyboard-open");
const height = () => root.style.getPropertyValue("--app-viewport-height");

let viewport: ReturnType<typeof fakeViewport>;
let input: HTMLInputElement;
let added: Array<[string, EventListenerOrEventListenerObject]>;
let removed: Array<[string, EventListenerOrEventListenerObject]>;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
  });
  viewport = fakeViewport();
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  vi.stubGlobal("innerHeight", 800);
  input = document.createElement("input");
  document.body.append(input);
  added = [];
  removed = [];
  for (const target of [window, document] as const) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation((type, listener, options) => {
      added.push([`${target === window ? "window" : "document"}:${type}`, listener]);
      add(type, listener, options);
    });
    vi.spyOn(target, "removeEventListener").mockImplementation((type, listener, options) => {
      removed.push([`${target === window ? "window" : "document"}:${type}`, listener]);
      remove(type, listener, options);
    });
  }
});

afterEach(() => {
  input.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "visualViewport");
});

describe("useViewportHeight", () => {
  it("follows the visual viewport while an editor has focus, after the frame, and lets go on blur", async () => {
    const page = await mount(createElement(Probe));
    input.focus();
    viewport.fire("resize");
    expect(keyboardOpen()).toBe(false);
    vi.advanceTimersByTime(16);
    expect(height()).toBe("400px");
    expect(keyboardOpen()).toBe(true);

    input.blur();
    window.dispatchEvent(new Event("focusout"));
    vi.advanceTimersByTime(16);
    expect(height()).toBe("");
    expect(keyboardOpen()).toBe(false);
    await page.unmount();
  });

  it("re-reads the geometry five times and a trigger during the chain does not start another", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const page = await mount(createElement(Probe));
    expect(timers).toHaveBeenCalledTimes(1);
    viewport.fire("resize");
    viewport.fire("scroll");
    window.dispatchEvent(new Event("focusin"));
    expect(timers).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(48);
    viewport.fire("resize");
    expect(timers).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5_000);
    expect(timers).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);

    viewport.fire("resize"); // a finished chain lets the next trigger start a new one
    expect(timers).toHaveBeenCalledTimes(6);
    await page.unmount();
  });

  it("picks up a keyboard that WebKit reports late, on a settle re-read with no event", async () => {
    viewport.height = 800;
    const page = await mount(createElement(Probe));
    input.focus();
    vi.advanceTimersByTime(16);
    expect(keyboardOpen()).toBe(false);
    viewport.height = 420; // no resize event arrives
    vi.advanceTimersByTime(48);
    expect(height()).toBe("420px");
    await page.unmount();
  });

  it("removes every listener, timer, frame and attribute on unmount, mid-chain", async () => {
    const page = await mount(createElement(Probe));
    input.focus();
    viewport.fire("resize");
    vi.advanceTimersByTime(60);
    expect(keyboardOpen()).toBe(true);
    expect(viewport.count()).toBe(2);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await page.unmount();
    expect(viewport.count()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(keyboardOpen()).toBe(false);
    expect(height()).toBe("");
    const mine = added.filter(([type]) => EXPECTED_LISTENERS.includes(type));
    expect(mine.map(([type]) => type).sort()).toEqual([...EXPECTED_LISTENERS].sort());
    for (const pair of mine) expect(removed).toContainEqual(pair);

    input.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(5_000);
    expect(keyboardOpen()).toBe(false);
  });

  it("does nothing without a visual viewport", async () => {
    Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
    const page = await mount(createElement(Probe));
    expect(vi.getTimerCount()).toBe(0);
    await page.unmount();
  });
});
