import { describe, expect, it } from "vitest";
import { terminalKeyData } from "./terminal-keys.ts";

describe("terminal key data", () => {
  it.each([
    [{ key: "ArrowDown" }, "\u001b[B"],
    [{ key: "Enter" }, "\r"],
    [{ key: "Enter", shiftKey: true }, "\n"],
    [{ key: "Tab" }, "\t"],
    [{ key: "Tab", shiftKey: true }, "\u001b[Z"],
    [{ key: "c", ctrlKey: true }, "\u0003"],
    [{ key: "b", altKey: true }, "\u001bb"],
    [{ key: "ArrowLeft", altKey: true }, "\u001bb"],
    [{ key: "ArrowRight", altKey: true }, "\u001bf"],
    [{ key: "Backspace" }, "\u007f"],
    [{ key: "Escape" }, "\u001b"],
    [{ key: "Home" }, "\u001b[H"],
    [{ key: "End" }, "\u001b[F"],
    [{ key: "Insert" }, "\u001b[2~"],
    [{ key: "Delete" }, "\u001b[3~"],
    [{ key: "PageUp" }, "\u001b[5~"],
    [{ key: "PageDown" }, "\u001b[6~"],
    [{ key: "@", ctrlKey: true, altKey: true }, null],
    [{ key: "v", ctrlKey: true }, null],
    [{ key: "a", metaKey: true }, null],
    [{ key: "a" }, null],
  ])("maps %j to %j", (event, expected) => {
    expect(
      terminalKeyData({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...event }),
    ).toBe(expected);
  });
});
