import { describe, expect, it } from "vitest";
import { EMPTY_VIEW, reduceSession } from "../../stores/session-reducer.ts";
import { transcriptItems } from "./transcript.vm.ts";

describe("transcriptItems", () => {
  it("maps authors, shows tool calls and results, and appends the partial reply", () => {
    let view = reduceSession(EMPTY_VIEW, {
      kind: "snapshot",
      status: "running",
      dialogs: [],
      messages: [
        { role: "user", content: "Run the check", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo ok" } }],
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "ok\n" }], timestamp: 3 },
      ],
    });
    view = reduceSession(view, {
      kind: "pi",
      event: { type: "message_start", message: { role: "assistant" } },
    });
    view = reduceSession(view, {
      kind: "pi",
      event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done" } },
    });
    expect(transcriptItems(view).map((item) => [item.author, item.text])).toEqual([
      ["you", "Run the check"],
      ["agent", "bash: echo ok"],
      ["tool", "ok\n"],
      ["agent", "Done"],
    ]);
  });

  it("shows a provider failure as its own item, after whatever the message said", () => {
    const view = reduceSession(EMPTY_VIEW, {
      kind: "snapshot",
      status: "idle",
      dialogs: [],
      messages: [
        { role: "user", content: "go", timestamp: 1 },
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "429 usage limit reached",
          timestamp: 2,
        },
      ],
    });
    expect(transcriptItems(view).map((item) => [item.author, item.text, item.failure ?? false])).toEqual([
      ["you", "go", false],
      ["agent", "429 usage limit reached", true],
    ]);
  });

  it("words a failure that came without a message", () => {
    const view = reduceSession(EMPTY_VIEW, {
      kind: "snapshot",
      status: "idle",
      dialogs: [],
      messages: [{ role: "assistant", content: [], stopReason: "error", timestamp: 2 }],
    });
    expect(transcriptItems(view)).toMatchObject([{ text: "Something went wrong.", failure: true }]);
  });

  it("keeps the text a failed message did write, then the failure", () => {
    const view = reduceSession(EMPTY_VIEW, {
      kind: "snapshot",
      status: "idle",
      dialogs: [],
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Starting..." }],
          stopReason: "error",
          errorMessage: "overloaded",
          timestamp: 2,
        },
      ],
    });
    expect(transcriptItems(view).map((item) => [item.text, item.failure ?? false])).toEqual([
      ["Starting...", false],
      ["overloaded", true],
    ]);
    expect(new Set(transcriptItems(view).map((item) => item.key)).size).toBe(2);
  });
});
