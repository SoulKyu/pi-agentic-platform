import { beforeEach, describe, expect, it } from "vitest";
import { useShellAnswers } from "./shell-answers.ts";

beforeEach(() => useShellAnswers.getState().reset());

describe("shell answers", () => {
  it("keeps the newest 32 blocks, replaces a block's status in place and resets", () => {
    const store = () => useShellAnswers.getState();
    for (let index = 0; index < 40; index += 1) store().set(`b${index}`, { since: index, answer: null });
    expect(Object.keys(store().byBlock)).toHaveLength(32);
    expect(store().byBlock["b0"]).toBeUndefined();
    expect(store().byBlock["b39"]).toEqual({ since: 39, answer: null });
    store().set("b39", { since: null, answer: { ok: true, text: "Typed." } });
    expect(Object.keys(store().byBlock)).toHaveLength(32);
    expect(store().byBlock["b39"]?.answer?.text).toBe("Typed.");
    store().reset();
    expect(store().byBlock).toEqual({});
  });
});
