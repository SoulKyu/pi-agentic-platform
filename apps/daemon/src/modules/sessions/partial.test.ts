import { describe, expect, it } from "vitest";
import { createPartialReply, MAX_PARTIAL_CHARS } from "./partial.ts";

const update = (assistantMessageEvent: Record<string, unknown>) => ({
  type: "message_update",
  assistantMessageEvent,
});

describe("partial reply", () => {
  it("rebuilds the blocks of the reply being written", () => {
    const partial = createPartialReply();
    expect(partial.current()).toBeNull();
    partial.apply({ type: "message_start", message: { role: "assistant" } });
    partial.apply(update({ type: "thinking_start", contentIndex: 0 }));
    partial.apply(update({ type: "thinking_delta", contentIndex: 0, delta: "hmm" }));
    partial.apply(update({ type: "toolcall_start", contentIndex: 2, id: "c1", toolName: "read" }));
    partial.apply(update({ type: "toolcall_delta", contentIndex: 2, delta: '{"path"' }));
    expect(partial.current()).toEqual({
      blocks: [
        { type: "thinking", text: "hmm" },
        { type: "text", text: "" },
        { type: "toolCall", text: '{"path"', id: "c1", name: "read" },
      ],
    });
  });

  it("hands out a copy: later deltas do not change what was taken", () => {
    const partial = createPartialReply();
    partial.apply({ type: "message_start", message: { role: "assistant" } });
    partial.apply(update({ type: "text_delta", contentIndex: 0, delta: "a" }));
    const taken = partial.current();
    partial.apply(update({ type: "text_delta", contentIndex: 0, delta: "b" }));
    expect(taken).toEqual({ blocks: [{ type: "text", text: "a" }] });
  });

  it("ends with the assistant's message_end and ignores other messages", () => {
    const partial = createPartialReply();
    partial.apply({ type: "message_start", message: { role: "user" } });
    expect(partial.current()).toBeNull();
    partial.apply({ type: "message_start", message: { role: "assistant" } });
    partial.apply({ type: "message_end", message: { role: "toolResult" } });
    expect(partial.current()).toEqual({ blocks: [] });
    partial.apply({ type: "message_end", message: { role: "assistant" } });
    expect(partial.current()).toBeNull();
  });

  it("ends with the run, and reset forgets the reply", () => {
    const partial = createPartialReply();
    for (const end of ["agent_end", "agent_settled"]) {
      partial.apply({ type: "message_start", message: { role: "assistant" } });
      partial.apply({ type: end });
      expect(partial.current()).toBeNull();
    }
    partial.apply({ type: "message_start", message: { role: "assistant" } });
    partial.reset();
    expect(partial.current()).toBeNull();
  });

  it("ignores a content index outside 0..63", () => {
    const partial = createPartialReply();
    partial.apply({ type: "message_start", message: { role: "assistant" } });
    partial.apply(update({ type: "text_delta", contentIndex: 64, delta: "x" }));
    partial.apply(update({ type: "text_delta", contentIndex: -1, delta: "x" }));
    expect(partial.current()).toEqual({ blocks: [] });
    partial.apply(update({ type: "text_delta", contentIndex: 63, delta: "x" }));
    expect(partial.current()?.blocks).toHaveLength(64);
  });

  it("drops a reply past MAX_PARTIAL_CHARS until the next one starts", () => {
    const partial = createPartialReply();
    partial.apply({ type: "message_start", message: { role: "assistant" } });
    partial.apply(update({ type: "text_delta", contentIndex: 0, delta: "x".repeat(MAX_PARTIAL_CHARS) }));
    expect(partial.current()?.blocks[0]?.text).toHaveLength(MAX_PARTIAL_CHARS);
    partial.apply(update({ type: "text_delta", contentIndex: 0, delta: "y" }));
    expect(partial.current()).toBeNull();
    partial.apply(update({ type: "text_delta", contentIndex: 0, delta: "z" }));
    expect(partial.current()).toBeNull();
    partial.apply({ type: "message_start", message: { role: "assistant" } });
    expect(partial.current()).toEqual({ blocks: [] });
  });
});
