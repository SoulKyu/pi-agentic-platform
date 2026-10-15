// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLaunchKey, MODE_KEY, readMode, rememberMode } from "./home-mode.ts";

const key = (init: {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}) => ({
  key: init.key,
  shiftKey: init.shiftKey ?? false,
  altKey: init.altKey ?? false,
  nativeEvent: {
    isComposing: init.isComposing ?? false,
    ...(init.keyCode === undefined ? {} : { keyCode: init.keyCode }),
  },
});

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("the home's mode, per device (PH14)", () => {
  it("starts on Session, then reads back the last mode chosen; anything else stored reads as Session", () => {
    expect(readMode()).toBe("session");
    rememberMode("fanout");
    expect(localStorage.getItem(MODE_KEY)).toBe("fanout");
    expect(readMode()).toBe("fanout");
    localStorage.setItem(MODE_KEY, "agent");
    expect(readMode()).toBe("session");
  });

  it("goes on when storage refuses, for the page only", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    });
    expect(() => rememberMode("lane")).not.toThrow();
    expect(readMode()).toBe("session");
  });
});

describe("isLaunchKey (§3.1, PH6, Review Focus 3)", () => {
  it("launches on Enter, Ctrl+Enter too; Shift+Enter and Alt+Enter are a new line", () => {
    expect(isLaunchKey(key({ key: "Enter" }), false)).toBe(true);
    expect(isLaunchKey(key({ key: "Enter", shiftKey: true }), false)).toBe(false);
    expect(isLaunchKey(key({ key: "Enter", altKey: true }), false)).toBe(false);
    expect(isLaunchKey(key({ key: "a" }), false)).toBe(false);
  });

  it("never launches on an input method's Enter, nor on a phone's Enter", () => {
    expect(isLaunchKey(key({ key: "Enter", isComposing: true }), false)).toBe(false);
    expect(isLaunchKey(key({ key: "Enter", keyCode: 229 }), false)).toBe(false);
    expect(isLaunchKey(key({ key: "Enter" }), true)).toBe(false);
  });
});
