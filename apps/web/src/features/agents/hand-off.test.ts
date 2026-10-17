import { describe, expect, it } from "vitest";
import { lastAssistantQuote, parseHandOff } from "./hand-off.ts";

const agents = [
  { id: "atlas-1a2b", name: "Atlas" },
  { id: "scout-3c4d", name: "Scout" },
  { id: "scouty-5e6f", name: "Scouty" },
];
const parse = (text: string, own = "atlas-1a2b") => parseHandOff(text, own, agents);

describe("parseHandOff (M11R123)", () => {
  it("hands `@Scout do it` to Scout with the text after the name", () => {
    expect(parse("@Scout do it")).toEqual({ agentId: "scout-3c4d", name: "Scout", prompt: "do it" });
  });

  it("takes the whole text after the first blank, newlines included", () => {
    expect(parse("@Scout\nline one\nline two")).toEqual({
      agentId: "scout-3c4d",
      name: "Scout",
      prompt: "line one\nline two",
    });
  });

  it("matches the exact name only: case, prefix and longer names are no hand-off", () => {
    expect(parse("@scout do it")).toBeNull();
    expect(parse("@Sco do it")).toBeNull();
    expect(parse("@Scoutx do it")).toBeNull();
  });

  it("tells a name from a longer name that starts with it", () => {
    expect(parse("@Scouty go")).toEqual({ agentId: "scouty-5e6f", name: "Scouty", prompt: "go" });
  });

  it("picks the longest exact name, whatever the list order (names may hold a blank)", () => {
    const scout = { id: "scout-3c4d", name: "Scout" };
    const two = { id: "scout2-7a8b", name: "Scout Two" };
    for (const list of [
      [scout, two],
      [two, scout],
    ]) {
      expect(parseHandOff("@Scout Two do it", "atlas-1a2b", list)).toEqual({
        agentId: "scout2-7a8b",
        name: "Scout Two",
        prompt: "do it",
      });
      expect(parseHandOff("@Scout do it", "atlas-1a2b", list)).toEqual({
        agentId: "scout-3c4d",
        name: "Scout",
        prompt: "do it",
      });
    }
  });

  it("needs a text after the name", () => {
    expect(parse("@Scout")).toBeNull();
    expect(parse("@Scout   \n ")).toBeNull();
  });

  it("is no hand-off to the agent whose thread it is", () => {
    expect(parse("@Atlas do it")).toBeNull();
  });

  it("only looks at the start of the message", () => {
    expect(parse("email@Scout x")).toBeNull();
    expect(parse("hi @Scout x")).toBeNull();
    expect(parse(" @Scout x")).toBeNull();
  });

  it("is never a hand-off without other agents (a plain session passes none)", () => {
    expect(parseHandOff("@Scout do it", "atlas-1a2b", [])).toBeNull();
  });
});

describe("lastAssistantQuote", () => {
  const message = (role: string, text: string) => ({ role, text });
  it("is the text of the newest assistant message with text", () => {
    expect(
      lastAssistantQuote([
        message("assistant", "first"),
        message("user", "q"),
        message("assistant", "second"),
        message("toolResult", "out"),
        message("assistant", ""),
      ]),
    ).toBe("second");
  });
  it("is undefined when the thread has none", () => {
    expect(lastAssistantQuote([message("user", "q")])).toBeUndefined();
  });
  it("is clipped to the queue prompt limit and stripped of hidden characters", () => {
    const quote = lastAssistantQuote([message("assistant", `a\u202eb${"x".repeat(25_000)}`)]);
    expect(quote?.length).toBe(20_000);
    expect(quote?.startsWith("ab")).toBe(true);
  });
});
