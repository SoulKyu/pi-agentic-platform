import { describe, expect, it } from "vitest";
import { toExtensionErrorRecord, toWireEvent } from "./wire-events.ts";

describe("toWireEvent: images of a user message", () => {
  it.each(["message_start", "message_end"])("%s carries each image as its type and size", (type) => {
    const message = {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", data: "QUJD", mimeType: "image/png" },
      ],
    };
    expect(toWireEvent({ type, message } as never)).toEqual({
      type,
      message: {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mimeType: "image/png", omitted: true, bytes: 3 },
        ],
      },
    });
  });
});

describe("toWireEvent: images of a tool result", () => {
  const content = [
    { type: "text", text: "Read image file" },
    { type: "image", data: "QUJD", mimeType: "image/png" },
  ];
  const omitted = [
    { type: "text", text: "Read image file" },
    { type: "image", mimeType: "image/png", omitted: true, bytes: 3 },
  ];
  it("keeps the type and size of an image in tool_execution_end", () => {
    const event = { type: "tool_execution_end", toolCallId: "c1", result: { content, details: undefined } };
    expect(toWireEvent(event as never)).toEqual({
      type: "tool_execution_end",
      toolCallId: "c1",
      result: { content: omitted, details: undefined },
    });
  });
  it("drops the second copy of the image in structuredContent", () => {
    const event = {
      type: "tool_execution_end",
      result: {
        content,
        structuredContent: { type: "image", data: "QUJD", mimeType: "image/png", note: "n" },
      },
    };
    expect(toWireEvent(event as never)).toMatchObject({
      result: { structuredContent: { type: "image", mimeType: "image/png", omitted: true, bytes: 3 } },
    });
  });
  it("keeps the type and size of an image in tool_execution_update", () => {
    const event = { type: "tool_execution_update", toolCallId: "c1", partialResult: { content } };
    expect(toWireEvent(event as never)).toEqual({
      type: "tool_execution_update",
      toolCallId: "c1",
      partialResult: { content: omitted },
    });
  });
});

describe("toWireEvent", () => {
  it("drops cumulative partials from message_update and keeps delta and usage", () => {
    const event = {
      type: "message_update",
      message: { role: "assistant", usage: { input: 3, output: 1 } },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Hi",
        partial: { content: [{ type: "text", text: "Hi" }] },
      },
    };
    expect(toWireEvent(event as never)).toEqual({
      type: "message_update",
      usage: { input: 3, output: 1 },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi" },
    });
  });

  it("names the tool call on toolcall_start", () => {
    const event = {
      type: "message_update",
      message: { usage: {} },
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 1,
        partial: { content: [{ type: "text" }, { type: "toolCall", id: "call-1", name: "bash" }] },
      },
    };
    expect(toWireEvent(event as never)).toMatchObject({
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "call-1", toolName: "bash" },
    });
  });

  it("names nothing when the started block is missing or has no string id and name", () => {
    const start = (partial: unknown) =>
      toWireEvent({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "toolcall_start", contentIndex: 3, partial },
      } as never);
    expect(start({ content: [] })).toEqual({
      type: "message_update",
      usage: undefined,
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 3 },
    });
    expect(start({ content: [null, null, null, { id: 7, name: 9 }] })).toEqual({
      type: "message_update",
      usage: undefined,
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 3 },
    });
  });

  it("does not name a tool on events other than toolcall_start", () => {
    const wire = toWireEvent({
      type: "message_update",
      message: { usage: { input: 1 } },
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: "{",
        partial: { content: [{ type: "toolCall", id: "call-1", name: "bash" }] },
      },
    } as never);
    expect(wire).toEqual({
      type: "message_update",
      usage: { input: 1 },
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "{" },
    });
  });

  it("drops what grows with the run: every message of agent_end and the tool results of turn_end", () => {
    const big = { role: "user", content: "x".repeat(1000) };
    expect(toWireEvent({ type: "agent_end", messages: [big, big] } as never)).toEqual({ type: "agent_end" });
    expect(
      toWireEvent({ type: "turn_end", message: { role: "assistant" }, toolResults: [big] } as never),
    ).toEqual({ type: "turn_end", message: { role: "assistant" } });
  });

  it("passes other events through unchanged", () => {
    expect(toWireEvent({ type: "agent_settled", aborted: false } as never)).toEqual({
      type: "agent_settled",
      aborted: false,
    });
  });
});

describe("toExtensionErrorRecord", () => {
  it("carries the three fields as they are when they are short", () => {
    expect(toExtensionErrorRecord({ extensionPath: "/p/x.js", event: "tool_call", error: "boom" })).toEqual({
      type: "extension_error",
      extensionPath: "/p/x.js",
      event: "tool_call",
      error: "boom",
    });
  });

  it("clips every string at 2000 characters, whatever the extension sent", () => {
    const long = "z".repeat(10_000);
    const record = toExtensionErrorRecord({ extensionPath: long, event: long, error: long });
    expect([record.extensionPath.length, record.event.length, record.error.length]).toEqual([
      2000, 2000, 2000,
    ]);
  });
});

describe("slim wire events", () => {
  it("keeps an entry's identity and drops its body", () => {
    const event = {
      type: "entry_appended",
      entry: {
        type: "message",
        id: "e2",
        parentId: "e1",
        timestamp: "2026-10-11T00:00:00.000Z",
        message: {
          role: "toolResult",
          toolCallId: "c1",
          content: [{ type: "text", text: "x".repeat(100_000) }],
          timestamp: 5,
        },
      },
    };
    expect(toWireEvent(event as never)).toEqual({
      type: "entry_appended",
      entry: {
        id: "e2",
        parentId: "e1",
        type: "message",
        timestamp: "2026-10-11T00:00:00.000Z",
        role: "toolResult",
        toolCallId: "c1",
        messageTimestamp: 5,
      },
    });
  });

  it("keeps a compaction's summary, clipped", () => {
    const event = {
      type: "entry_appended",
      entry: {
        type: "compaction",
        id: "c",
        parentId: "e2",
        timestamp: "t",
        summary: "s".repeat(70_000),
        tokensBefore: 900,
        firstKeptEntryId: "e1",
      },
    };
    const wire = toWireEvent(event as never) as unknown as {
      entry: { summary: string; tokensBefore: number };
    };
    expect(wire.entry.summary).toHaveLength(65_536);
    expect(wire.entry.tokensBefore).toBe(900);
  });

  it("sends queue previews with the full count and size", () => {
    const wire = toWireEvent({
      type: "queue_update",
      steering: ["é".repeat(3000)],
      followUp: ["b"],
    } as never);
    expect(wire).toEqual({
      type: "queue_update",
      steering: ["é".repeat(2000)],
      followUp: ["b"],
      count: 2,
      bytes: 6001,
    });
  });
});
