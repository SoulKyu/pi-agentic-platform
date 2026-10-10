import { describe, expect, it } from "vitest";
import { toWireEvent } from "./wire-events.ts";

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

  it("passes other events through unchanged", () => {
    expect(toWireEvent({ type: "agent_settled", aborted: false } as never)).toEqual({
      type: "agent_settled",
      aborted: false,
    });
  });
});
