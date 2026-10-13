import { describe, expect, it } from "vitest";
import {
  ARG_PREVIEW_CHARS,
  clipArguments,
  clipMessage,
  clipPiEvent,
  MAX_ITEMS,
  TOOL_PREVIEW_CHARS,
  UPDATE_PREVIEW_CHARS,
} from "./wire-clip.ts";

describe("wire clipping", () => {
  it("cuts an argument string without splitting a surrogate pair", () => {
    expect(clipArguments(`${"a".repeat(7999)}\u{1F600}`)).toEqual({ value: "a".repeat(7999), cut: true });
  });

  it("cuts a tool result to a preview and says how long it was", () => {
    const message = {
      role: "toolResult",
      toolCallId: "c1",
      content: [
        { type: "text", text: "a".repeat(TOOL_PREVIEW_CHARS) },
        { type: "text", text: "b".repeat(10) },
      ],
    };
    expect(clipMessage(message)).toEqual({
      ...message,
      content: [{ type: "text", text: "a".repeat(TOOL_PREVIEW_CHARS) }],
      papTruncated: { chars: TOOL_PREVIEW_CHARS + 10 },
    });
  });

  it("replaces images by their size and drops large structured details", () => {
    const message = {
      role: "toolResult",
      toolCallId: "c1",
      content: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
      details: { diff: "d".repeat(9000) },
    };
    expect(clipMessage(message)).toEqual({
      role: "toolResult",
      toolCallId: "c1",
      content: [{ type: "image", mimeType: "image/png", omitted: true, bytes: 3 }],
      details: undefined,
      papTruncated: { chars: 0 },
    });
  });

  it("cuts long tool-call arguments and marks the call", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "c1",
          name: "write",
          arguments: { path: "a.txt", content: "z".repeat(ARG_PREVIEW_CHARS + 1) },
        },
      ],
    };
    const clipped = clipMessage(message) as {
      content: Array<{ arguments: { content: string }; papTruncated?: boolean }>;
    };
    expect(clipped.content[0]?.arguments.content).toHaveLength(ARG_PREVIEW_CHARS);
    expect(clipped.content[0]?.papTruncated).toBe(true);
    expect(clipMessage({ role: "assistant", content: [{ type: "text", text: "short" }] })).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "short" }],
    });
  });

  it("cuts arrays and objects wider than MAX_ITEMS", () => {
    const wide = clipArguments({ list: Array.from({ length: MAX_ITEMS + 5 }, (_, i) => i) });
    expect(wide.cut).toBe(true);
    expect((wide.value as { list: number[] }).list).toHaveLength(MAX_ITEMS);
  });

  it("sends a tool's end without its result, the tail of its progress, and nothing of nested progress", () => {
    expect(
      clipPiEvent({
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "bash",
        result: { content: [] },
        isError: true,
      }),
    ).toEqual({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: true });
    const update = clipPiEvent({
      type: "tool_execution_update",
      toolCallId: "c1",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: `${"x".repeat(5000)}END` }] },
    }) as unknown as { partialResult: { content: Array<{ text: string }> } };
    expect(update.partialResult.content[0]?.text).toHaveLength(UPDATE_PREVIEW_CHARS);
    expect(update.partialResult.content[0]?.text.endsWith("END")).toBe(true);
    expect(
      clipPiEvent({
        type: "tool_execution_update",
        toolCallId: "c1/1",
        parentToolCallId: "c1",
        partialResult: {},
      }),
    ).toBeNull();
  });

  it("drops the text of a finished block and clips a finished tool call's arguments (M2-RT-30, R111)", () => {
    const end = clipPiEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "x".repeat(900_000) },
    });
    expect(end).toEqual({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 0 },
    });
    const call = clipPiEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: { type: "toolCall", id: "c1", name: "write", arguments: { content: "z".repeat(900_000) } },
      },
    }) as unknown as {
      assistantMessageEvent: { toolCall: { arguments: { content: string }; papTruncated?: boolean } };
    };
    expect(call.assistantMessageEvent.toolCall.arguments.content).toHaveLength(ARG_PREVIEW_CHARS);
    expect(call.assistantMessageEvent.toolCall.papTruncated).toBe(true);
  });

  it("clips the assistant message of a turn_end like its message_end (a 900 KB write call is not sent whole again)", () => {
    const message = {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "write", arguments: { content: "w".repeat(900_000) } }],
    };
    const clipped = clipPiEvent({ type: "turn_end", message }) as unknown as {
      message: { content: Array<{ arguments: { content: string }; papTruncated?: boolean }> };
    };
    expect(clipped.message.content[0]?.arguments.content).toHaveLength(ARG_PREVIEW_CHARS);
    expect(clipped.message.content[0]?.papTruncated).toBe(true);
    expect(clipPiEvent({ type: "turn_end" })).toEqual({ type: "turn_end" });
  });

  it("replaces the error text of compaction and retry events by a flag", () => {
    const text = "boom /home/u/.pi/agent/auth.json";
    expect(
      clipPiEvent({ type: "compaction_end", reason: "manual", aborted: false, errorMessage: text }),
    ).toEqual({
      type: "compaction_end",
      reason: "manual",
      aborted: false,
      failed: true,
    });
    expect(clipPiEvent({ type: "compaction_end", reason: "manual", aborted: false })).toEqual({
      type: "compaction_end",
      reason: "manual",
      aborted: false,
    });
    expect(clipPiEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: text })).toEqual(
      {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
      },
    );
    expect(clipPiEvent({ type: "auto_retry_end", success: false, attempt: 3, finalError: text })).toEqual({
      type: "auto_retry_end",
      success: false,
      attempt: 3,
      failed: true,
    });
    expect(clipPiEvent({ type: "summarization_retry_scheduled", attempt: 1, errorMessage: text })).toEqual({
      type: "summarization_retry_scheduled",
      attempt: 1,
    });
  });
});
