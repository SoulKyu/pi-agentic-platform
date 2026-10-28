import { describe, expect, it } from "vitest";
import { toMessageView } from "./row-view.ts";

const reply = (usage: unknown, stopReason = "stop") =>
  toMessageView({ role: "assistant", content: "hi", timestamp: 1, stopReason, usage });

describe("MessageView.contextTokens", () => {
  it("an assistant message's context tokens are totalTokens, else the four counts; an error, an aborted reply or a zero usage has none", () => {
    expect(reply({ totalTokens: 900, input: 1, output: 1, cacheRead: 1, cacheWrite: 1 })?.contextTokens).toBe(
      900,
    );
    expect(
      reply({ totalTokens: 0, input: 10, output: 20, cacheRead: 30, cacheWrite: 40 })?.contextTokens,
    ).toBe(100);
    expect(reply({ input: 10, output: 20 })?.contextTokens).toBe(30);
    expect(reply({ totalTokens: 900 }, "error")?.contextTokens).toBeUndefined();
    expect(reply({ totalTokens: 900 }, "aborted")?.contextTokens).toBeUndefined();
    expect(reply({ totalTokens: 0, input: 0, output: 0 })?.contextTokens).toBeUndefined();
    expect(reply(undefined)?.contextTokens).toBeUndefined();
    expect(reply({ input: -5, output: 20 })?.contextTokens).toBeUndefined();
    expect(reply({ input: Number.NaN, output: 20 })?.contextTokens).toBeUndefined();
    expect(
      toMessageView({ role: "user", content: "x", timestamp: 1, usage: { totalTokens: 5 } })?.contextTokens,
    ).toBeUndefined();
  });
});
