import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAutoName } from "./auto-name.ts";

const text = (value: string) => ({ stopReason: "stop", content: [{ type: "text", text: value }] });

function stub(options: {
  model?: object | undefined;
  levels?: string[];
  complete?: (model: unknown, context: unknown, options: Record<string, unknown>) => Promise<unknown>;
}) {
  const completeSimple = vi.fn(options.complete ?? (async () => text("A title")));
  const setSessionName = vi.fn();
  const session = {
    model: "model" in options ? options.model : { id: "m" },
    messages: [{ role: "user", content: "hello" }],
    getAvailableThinkingLevels: () => options.levels ?? ["off", "low"],
    modelRuntime: { completeSimple },
    setSessionName,
  };
  const sent: Record<string, unknown>[] = [];
  const run = () =>
    handleAutoName(session as never, { id: "c1" }, (record) => sent.push(record as Record<string, unknown>));
  return { run, sent, completeSimple, setSessionName };
}

afterEach(() => vi.useRealTimers());

describe("handleAutoName", () => {
  it("fails with no model and names nothing", async () => {
    const bed = stub({ model: undefined });
    await bed.run();
    expect(bed.sent).toEqual([
      { type: "response", id: "c1", command: "auto_name", success: false, error: "no model" },
    ]);
    expect(bed.setSessionName).not.toHaveBeenCalled();
  });

  it("answers a failure of the model call, with no timer left", async () => {
    vi.useFakeTimers();
    const bed = stub({ complete: () => Promise.reject(new Error("boom")) });
    await bed.run();
    expect(bed.sent).toEqual([
      { type: "response", id: "c1", command: "auto_name", success: false, error: "boom" },
    ]);
    expect(bed.setSessionName).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers a stopReason error as its own failure", async () => {
    vi.useFakeTimers();
    const bed = stub({
      complete: async () => ({ stopReason: "error", content: [], errorMessage: "secret detail" }),
    });
    await bed.run();
    expect(bed.sent).toEqual([
      { type: "response", id: "c1", command: "auto_name", success: false, error: "the model call failed" },
    ]);
    expect(bed.setSessionName).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out after 90 000 ms with a message of its own", async () => {
    vi.useFakeTimers();
    const bed = stub({
      complete: (_model, _context, options) =>
        new Promise((_resolve, reject) => {
          (options.signal as AbortSignal).addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const done = bed.run();
    await vi.advanceTimersByTimeAsync(89_999);
    expect(bed.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(bed.sent).toEqual([
      {
        type: "response",
        id: "c1",
        command: "auto_name",
        success: false,
        error: "title generation timed out",
      },
    ]);
    expect(bed.setSessionName).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([[""], ["   \n "]])("gives up on the unusable output %j", async (output) => {
    const bed = stub({ complete: async () => text(output) });
    await bed.run();
    expect(bed.sent).toEqual([
      { type: "response", id: "c1", command: "auto_name", success: false, error: "the model gave no title" },
    ]);
    expect(bed.setSessionName).not.toHaveBeenCalled();
  });

  it("names the session on success and leaves no timer", async () => {
    vi.useFakeTimers();
    const bed = stub({});
    await bed.run();
    expect(bed.sent).toEqual([
      { type: "response", id: "c1", command: "auto_name", success: true, data: { title: "A title" } },
    ]);
    expect(bed.setSessionName).toHaveBeenCalledWith("A title");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends no reasoning option when the model can turn it off, the cheapest level otherwise", async () => {
    const off = stub({ levels: ["off", "low"] });
    await off.run();
    expect(off.completeSimple.mock.calls[0]?.[2]).not.toHaveProperty("reasoning");
    const low = stub({ levels: ["low", "high"] });
    await low.run();
    expect(low.completeSimple.mock.calls[0]?.[2]).toMatchObject({ reasoning: "low", maxTokens: 256 });
  });
});
