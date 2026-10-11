// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRuntime, stopRuntime } from "./index.ts";

afterEach(() => {
  stopRuntime();
  vi.restoreAllMocks();
});

describe("getRuntime", () => {
  it("builds the runtime once", () => {
    expect(getRuntime()).toBe(getRuntime());
  });

  it("stopRuntime closes the socket's supervisor and the page listeners, and the next call builds anew", () => {
    const first = getRuntime();
    const stop = vi.spyOn(first.connection, "stop");
    const removed = vi.spyOn(window, "removeEventListener");
    const removedFromDocument = vi.spyOn(document, "removeEventListener");
    stopRuntime();
    expect(stop).toHaveBeenCalledOnce();
    expect(removed).toHaveBeenCalledWith("online", expect.any(Function));
    expect(removedFromDocument).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(getRuntime()).not.toBe(first);
  });

  it("nudges the connection when the browser comes back online, and no more after stopRuntime", () => {
    const runtime = getRuntime();
    const nudge = vi.spyOn(runtime.connection, "nudge");
    window.dispatchEvent(new Event("online"));
    expect(nudge).toHaveBeenCalledOnce();
    stopRuntime();
    window.dispatchEvent(new Event("online"));
    expect(nudge).toHaveBeenCalledOnce();
  });

  it("does nothing when stopped twice", () => {
    getRuntime();
    stopRuntime();
    expect(() => stopRuntime()).not.toThrow();
  });
});
