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
});
