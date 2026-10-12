import { describe, expect, it } from "vitest";
import { startLiveSession } from "./live-session.ts";
import { createLiveBed, piEvent } from "./testing/live-bed.ts";

const setup = createLiveBed(startLiveSession);

describe("the partial reply and large events", () => {
  it("ends the partial reply with its message even when the message is too large to stream", async () => {
    const { live, worker, clock } = setup();
    worker.emit(piEvent({ type: "message_start", message: { role: "assistant", content: [] } }));
    worker.emit(
      piEvent({
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "x".repeat(1_100_000) },
      }),
    );
    worker.emit(
      piEvent({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "y".repeat(1_100_000) }] },
      }),
    );
    await clock.advance(50);
    expect(live.partial()).toBeNull();
  });
});

describe("tool output on the wire", () => {
  it("publishes a tool result clipped, and the run view holds the same row", () => {
    const { live, worker, published } = setup();
    worker.emit(piEvent({ type: "agent_start" }));
    const message = {
      role: "toolResult",
      toolCallId: "c1",
      content: [{ type: "text", text: "o".repeat(30_000) }],
    };
    worker.emit(piEvent({ type: "message_end", message }));
    const sent = published.flatMap((event) =>
      event.kind === "pi" && event.event.type === "message_end" ? [event.event.message] : [],
    );
    const clipped = {
      ...message,
      content: [{ type: "text", text: "o".repeat(8000) }],
      papTruncated: { chars: 30_000 },
    };
    expect(sent).toEqual([clipped]);
    expect(live.runView()?.rows).toEqual([{ entryId: null, message: clipped }]);
  });

  it("does not publish the progress of a call made inside another tool", async () => {
    const { worker, published, clock } = setup();
    worker.emit(
      piEvent({
        type: "tool_execution_update",
        toolCallId: "c1/1",
        parentToolCallId: "c1",
        partialResult: { content: [{ type: "text", text: "inner" }] },
      }),
    );
    await clock.advance(50);
    expect(published.filter((event) => event.kind === "pi")).toEqual([]);
  });
});
