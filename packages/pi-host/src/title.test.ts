import { describe, expect, it } from "vitest";
import { buildTitleTranscript, parseTitle } from "./title.ts";

const user = (text: string) => ({ role: "user", content: text });
const assistant = (text: string) => ({
  role: "assistant",
  content: [
    { type: "text", text },
    { type: "toolCall", id: "c", name: "bash", arguments: { command: "ls" } },
  ],
});
const tool = { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "secret output" }] };

describe("title transcript", () => {
  it("keeps every user turn and the replies' text, drops tool traffic", () => {
    const text = buildTitleTranscript([
      user("Fix the login bug"),
      assistant("Looking."),
      tool,
      user("Also the logout"),
      assistant("Done both."),
    ]);
    expect(text).toContain("User: Fix the login bug");
    expect(text).toContain("User: Also the logout");
    expect(text).toContain("Assistant: Done both.");
    expect(text).not.toContain("secret output");
    expect(text).not.toMatch(/\bls\b|bash/);
  });

  it("stays within its budget, keeping the opening turns", () => {
    const many = Array.from({ length: 200 }, (_, i) => user(`turn ${i} ${"x".repeat(500)}`));
    const text = buildTitleTranscript(many);
    expect(text.length).toBeLessThanOrEqual(6000);
    expect(text).toContain("turn 0 ");
    expect(text).toContain("turn 199 ");
  });

  it("is empty without user text, and images become a placeholder", () => {
    expect(buildTitleTranscript([assistant("hello")])).toBe("");
    expect(
      buildTitleTranscript([{ role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }] }]),
    ).toContain("[image]");
  });
});

describe("parseTitle", () => {
  it.each([
    ["Fix the login bug", "Fix the login bug"],
    ['"Fix the login bug"', "Fix the login bug"],
    ["Title: **Fix the login bug**\nBecause…", "Fix the login bug"],
    ["   \n  ", null],
  ])("reads %j as %j", (raw, expected) => {
    expect(parseTitle(raw)).toBe(expected);
  });

  it("cuts a long answer to 80 characters on a word", () => {
    const title = parseTitle("word ".repeat(40)) ?? "";
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith("…")).toBe(true);
  });

  it.each([
    ["\u202Eevil", "evil"],
    ["a\u200Bb", "a b"],
    ["a\u0000b", "a b"],
    ["\u0007\u200B", null],
  ])("replaces control and format characters in %j", (raw, expected) => {
    expect(parseTitle(raw)).toBe(expected);
  });

  it("never cuts inside an astral character", () => {
    const title = parseTitle(`${"a".repeat(78)}\u{1F600}\u{1F600}\u{1F600}`);
    expect(title).toBe(`${"a".repeat(78)}\u{1F600}…`);
    expect(parseTitle(`${"a".repeat(30)} ${"\u{1F600}".repeat(60)}`)).toBe(`${"a".repeat(30)}…`);
  });
});
