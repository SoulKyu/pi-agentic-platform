import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSuggestCommit } from "./suggest-commit.ts";

const text = (value: string) => ({ stopReason: "stop", content: [{ type: "text", text: value }] });

function stub(options: {
  model?: object | undefined;
  complete?: (model: unknown, context: unknown, options: Record<string, unknown>) => Promise<unknown>;
}) {
  const completeSimple = vi.fn(options.complete ?? (async () => text("feat: add a thing")));
  const session = {
    model: "model" in options ? options.model : { id: "m" },
    getAvailableThinkingLevels: () => ["off", "low"],
    modelRuntime: { completeSimple },
  };
  const sent: Record<string, unknown>[] = [];
  const run = (diff = "diff --git a/a b/a\n+x\n") =>
    handleSuggestCommit(session as never, { id: "c1", diff }, (record) =>
      sent.push(record as Record<string, unknown>),
    );
  return { run, sent, completeSimple };
}

const failure = (error: string) => ({
  type: "response",
  id: "c1",
  command: "suggest_commit",
  success: false,
  error,
});

afterEach(() => vi.useRealTimers());

describe("handleSuggestCommit", () => {
  it("fails with no model", async () => {
    const bed = stub({ model: undefined });
    await bed.run();
    expect(bed.sent).toEqual([failure("no model")]);
  });

  it("returns the answer unfenced", async () => {
    const bed = stub({ complete: async () => text("```text\nfix: stop the leak\n\nBody line.\n```") });
    await bed.run();
    expect(bed.sent).toEqual([
      {
        type: "response",
        id: "c1",
        command: "suggest_commit",
        success: true,
        data: { message: "fix: stop the leak\n\nBody line." },
      },
    ]);
  });

  it("clips the answer to 2 000 characters", async () => {
    const bed = stub({ complete: async () => text(`feat: ${"x".repeat(5000)}`) });
    await bed.run();
    const message = (bed.sent[0]?.data as { message: string }).message;
    expect(message).toHaveLength(2000);
  });

  it("asks for a Conventional Commits message with 400 tokens, the diff as the user turn, no tools", async () => {
    const bed = stub({});
    await bed.run("DIFFTEXT");
    const [, context, options] = bed.completeSimple.mock.calls[0] ?? [];
    expect((context as { systemPrompt: string }).systemPrompt).toMatch(/Conventional Commits/);
    expect((context as { systemPrompt: string }).systemPrompt).toMatch(/72/);
    expect(JSON.stringify((context as { messages: unknown }).messages)).toContain("DIFFTEXT");
    expect(context).not.toHaveProperty("tools");
    expect(options).toMatchObject({ maxTokens: 400 });
  });

  it("gives up on an empty answer", async () => {
    const bed = stub({ complete: async () => text("  \n```\n```\n") });
    await bed.run();
    expect(bed.sent).toEqual([failure("the model gave no message")]);
  });

  it("answers a stopReason error without the provider's text", async () => {
    vi.useFakeTimers();
    const bed = stub({
      complete: async () => ({ stopReason: "error", content: [], errorMessage: "secret" }),
    });
    await bed.run();
    expect(bed.sent).toEqual([failure("the model call failed")]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out after 30 000 ms (fake clock) and leaves no timer", async () => {
    vi.useFakeTimers();
    const bed = stub({
      complete: (_model, _context, options) =>
        new Promise((_resolve, reject) => {
          (options.signal as AbortSignal).addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const done = bed.run();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(bed.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(bed.sent).toEqual([failure("commit message generation timed out")]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers a thrown failure", async () => {
    const bed = stub({ complete: () => Promise.reject(new Error("boom")) });
    await bed.run();
    expect(bed.sent).toEqual([failure("boom")]);
  });
});
