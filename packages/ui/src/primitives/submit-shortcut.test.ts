import { describe, expect, it } from "vitest";
import { isSubmitShortcut } from "./submit-shortcut.ts";

const press = (key: string, modifiers: { metaKey?: boolean; ctrlKey?: boolean }, isComposing = false) => ({
  key,
  metaKey: modifiers.metaKey ?? false,
  ctrlKey: modifiers.ctrlKey ?? false,
  nativeEvent: { isComposing },
});

describe("isSubmitShortcut", () => {
  it("accepts Ctrl+Enter and Cmd+Enter", () => {
    expect(isSubmitShortcut(press("Enter", { ctrlKey: true }))).toBe(true);
    expect(isSubmitShortcut(press("Enter", { metaKey: true }))).toBe(true);
  });

  it("ignores a plain Enter and other keys", () => {
    expect(isSubmitShortcut(press("Enter", {}))).toBe(false);
    expect(isSubmitShortcut(press("a", { ctrlKey: true }))).toBe(false);
  });

  it("ignores the keystroke that confirms an input-method composition", () => {
    expect(isSubmitShortcut(press("Enter", { ctrlKey: true }, true))).toBe(false);
  });
});
