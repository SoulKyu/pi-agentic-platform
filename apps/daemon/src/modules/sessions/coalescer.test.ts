import type { PiEvent } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createCoalescer, MAX_PENDING_ITEMS } from "./coalescer.ts";

const delta = (text: string, contentIndex = 0, type = "text_delta"): PiEvent => ({
  type: "message_update",
  assistantMessageEvent: { type, contentIndex, delta: text },
});

function setup() {
  const clock = createFakeClock();
  const sent: PiEvent[] = [];
  return { clock, sent, coalescer: createCoalescer({ clock, emit: (event) => void sent.push(event) }) };
}

describe("delta coalescer", () => {
  it("merges the deltas of a block and sends them after 50 ms", async () => {
    const { clock, sent, coalescer } = setup();
    for (const text of ["He", "ll", "o"]) coalescer.push(delta(text));
    expect(sent).toEqual([]);
    await clock.advance(49);
    expect(sent).toEqual([]);
    await clock.advance(1);
    expect(sent).toEqual([delta("Hello")]);
    expect(clock.pending()).toBe(0);
  });

  it("keeps blocks apart and sends pending deltas before any other event", () => {
    const { sent, coalescer, clock } = setup();
    coalescer.push(delta("thin", 0, "thinking_delta"));
    coalescer.push(delta("ans", 1));
    coalescer.push(delta("king", 0, "thinking_delta"));
    coalescer.push({ type: "message_end", message: { role: "assistant" } });
    expect(sent).toEqual([
      delta("thinking", 0, "thinking_delta"),
      delta("ans", 1),
      { type: "message_end", message: { role: "assistant" } },
    ]);
    expect(clock.pending()).toBe(0);
  });

  it("keeps the latest usage of a merged block", async () => {
    const { clock, sent, coalescer } = setup();
    coalescer.push({ ...delta("a"), usage: { output: 1 } });
    coalescer.push(delta("b"));
    await clock.advance(50);
    expect(sent).toEqual([{ ...delta("ab"), usage: { output: 1 } }]);
  });

  it("keeps only a tool's latest progress, and drops it when the tool ends", async () => {
    const { clock, sent, coalescer } = setup();
    coalescer.push({ type: "tool_execution_update", toolCallId: "c1", partialResult: "1" });
    coalescer.push({ type: "tool_execution_update", toolCallId: "c1", partialResult: "2" });
    await clock.advance(50);
    expect(sent).toEqual([{ type: "tool_execution_update", toolCallId: "c1", partialResult: "2" }]);
    coalescer.push({ type: "tool_execution_update", toolCallId: "c1", partialResult: "3" });
    coalescer.push({ type: "tool_execution_end", toolCallId: "c1", isError: false });
    expect(sent.at(-1)).toEqual({ type: "tool_execution_end", toolCallId: "c1", isError: false });
    expect(sent).toHaveLength(2);
  });

  it("sends at once past 256 distinct pending tools", () => {
    const { sent, coalescer } = setup();
    for (let i = 0; i < MAX_PENDING_ITEMS; i++)
      coalescer.push({ type: "tool_execution_update", toolCallId: `c${i}`, partialResult: "x" });
    expect(sent).toHaveLength(0);
    coalescer.push({ type: "tool_execution_update", toolCallId: "last", partialResult: "x" });
    expect(sent).toHaveLength(MAX_PENDING_ITEMS + 1);
  });

  it("sends at once past 256 distinct pending blocks", () => {
    const { sent, coalescer } = setup();
    for (let i = 0; i < MAX_PENDING_ITEMS; i++) coalescer.push(delta("x", i));
    expect(sent).toHaveLength(0);
    coalescer.push(delta("x", MAX_PENDING_ITEMS));
    expect(sent).toHaveLength(MAX_PENDING_ITEMS + 1);
  });

  it("sends at once past 256 KiB pending, and not at exactly 256 KiB", () => {
    const { sent, coalescer } = setup();
    coalescer.push(delta("x".repeat(256 * 1024)));
    expect(sent).toHaveLength(0);
    coalescer.push(delta("y"));
    expect(sent).toHaveLength(1);
  });

  it("flush sends what is pending and disarms the timer; dispose leaves nothing armed or pending", async () => {
    const { clock, sent, coalescer } = setup();
    coalescer.push(delta("a"));
    coalescer.flush();
    expect(sent).toEqual([delta("a")]);
    expect(clock.pending()).toBe(0);
    coalescer.push(delta("y"));
    expect(clock.pending()).toBe(1);
    coalescer.dispose();
    expect(clock.pending()).toBe(0);
    await clock.advance(100);
    coalescer.flush();
    expect(sent).toEqual([delta("a")]);
  });
});
