// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard.ts";

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(document, "execCommand");
  document.body.replaceChildren();
});

const withoutClipboardApi = () =>
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });

describe("copyText", () => {
  it("uses the Clipboard API in a secure context", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    expect(await copyText("abc")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("abc");
  });

  it("over plain HTTP copies a selected textarea placed beside the focused control, then gives focus back", async () => {
    withoutClipboardApi();
    const dialog = document.createElement("div");
    const button = document.createElement("button");
    dialog.append(button);
    document.body.append(dialog);
    button.focus();
    let seen: { value?: string; parent?: Element | null } = {};
    const execCommand = vi.fn((command: string) => {
      const active = document.activeElement as HTMLTextAreaElement | null;
      seen = { value: active?.value, parent: active?.parentElement };
      return command === "copy";
    });
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    expect(await copyText("secret-1")).toBe(true);
    expect(seen).toEqual({ value: "secret-1", parent: dialog });
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("answers false, never throws, when neither path can copy", async () => {
    withoutClipboardApi();
    Object.defineProperty(document, "execCommand", {
      value: () => {
        throw new Error("unsupported");
      },
      configurable: true,
    });
    expect(await copyText("x")).toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });
});
