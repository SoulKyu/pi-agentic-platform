import { expect, it } from "vitest";
import { snippetParts } from "./snippet.ts";

it("splits a snippet on its markers", () => {
  expect(snippetParts("…the \u0002cafe\u0003 is \u0002open\u0003…")).toEqual([
    { text: "…the ", hit: false },
    { text: "cafe", hit: true },
    { text: " is ", hit: false },
    { text: "open", hit: true },
    { text: "…", hit: false },
  ]);
});

it("treats an unclosed mark as running to the end, a stray close as text, and drops other controls", () => {
  expect(snippetParts("a\u0002b")).toEqual([
    { text: "a", hit: false },
    { text: "b", hit: true },
  ]);
  expect(snippetParts("a\u0003b")).toEqual([{ text: "ab", hit: false }]);
  expect(snippetParts("x\u0000\u202Ey")).toEqual([{ text: "xy", hit: false }]);
  expect(snippetParts("")).toEqual([]);
});

it("keeps markup as plain text", () => {
  expect(snippetParts("<img src=x onerror=alert(1)> \u0002<b>\u0003")).toEqual([
    { text: "<img src=x onerror=alert(1)> ", hit: false },
    { text: "<b>", hit: true },
  ]);
});
