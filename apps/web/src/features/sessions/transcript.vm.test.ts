import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { EMPTY_VIEW, reduceSession } from "../../stores/session-reducer.ts";
import { transcriptItems } from "./transcript.vm.ts";

afterEach(() => setLocale("en"));

const snapshotOf = (status: string, messages: unknown[]) => ({
  kind: "snapshot",
  status,
  rows: messages.map((message) => ({ entryId: null, message })),
  dialogs: [],
  partial: null,
  queue: { steering: [], followUp: [], count: 0, bytes: 0 },
  statuses: [],
  widgets: [],
  title: null,
  panels: [],
  notices: [],
  decorationsTruncated: false,
  history: { hasMore: false, oldestEntryId: null, turnsBefore: 0 },
  activity: { compacting: false, retry: null },
  leafId: null,
  name: null,
});

describe("transcriptItems", () => {
  it("maps authors, shows tool calls and results, and appends the partial reply", () => {
    let view = reduceSession(
      EMPTY_VIEW,
      snapshotOf("running", [
        { role: "user", content: "Run the check", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo ok" } }],
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "ok\n" }], timestamp: 3 },
      ]),
    );
    view = reduceSession(view, {
      kind: "pi",
      event: { type: "message_start", message: { role: "assistant" } },
    });
    view = reduceSession(view, {
      kind: "pi",
      event: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Done" },
      },
    });
    expect(transcriptItems(view).map((item) => [item.author, item.text])).toEqual([
      ["you", "Run the check"],
      ["agent", "bash: echo ok"],
      ["tool", "ok\n"],
      ["agent", "Done"],
    ]);
  });

  it("shows only the text blocks of the partial reply", () => {
    const view = reduceSession(EMPTY_VIEW, {
      ...snapshotOf("running", []),
      partial: {
        blocks: [
          { type: "thinking", text: "hmm" },
          { type: "text", text: "Hel" },
          { type: "toolCall", text: "{}", id: "c1", name: "bash" },
          { type: "text", text: "lo" },
        ],
      },
    });
    expect(transcriptItems(view)).toEqual([{ key: "partial", author: "agent", text: "Hello" }]);
  });

  it("shows a provider failure as its own item, after whatever the message said", () => {
    const view = reduceSession(
      EMPTY_VIEW,
      snapshotOf("idle", [
        { role: "user", content: "go", timestamp: 1 },
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "429 usage limit reached",
          timestamp: 2,
        },
      ]),
    );
    expect(transcriptItems(view).map((item) => [item.author, item.text, item.failure ?? false])).toEqual([
      ["you", "go", false],
      ["agent", "429 usage limit reached", true],
    ]);
  });

  it("words a failure that came without a message", () => {
    const view = reduceSession(
      EMPTY_VIEW,
      snapshotOf("idle", [{ role: "assistant", content: [], stopReason: "error", timestamp: 2 }]),
    );
    expect(transcriptItems(view)).toMatchObject([{ text: "Something went wrong.", failure: true }]);
  });

  it("keeps the text a failed message did write, then the failure", () => {
    const view = reduceSession(
      EMPTY_VIEW,
      snapshotOf("idle", [
        {
          role: "assistant",
          content: [{ type: "text", text: "Starting..." }],
          stopReason: "error",
          errorMessage: "overloaded",
          timestamp: 2,
        },
      ]),
    );
    expect(transcriptItems(view).map((item) => [item.text, item.failure ?? false])).toEqual([
      ["Starting...", false],
      ["overloaded", true],
    ]);
    expect(new Set(transcriptItems(view).map((item) => item.key)).size).toBe(2);
  });

  it("shows an oversize row as an item with its size instead of dropping it, in English and French (R109)", () => {
    const view = reduceSession(
      EMPTY_VIEW,
      snapshotOf("idle", [
        { role: "toolResult", timestamp: 5, omitted: true, bytes: 300_000 },
        { role: "user", content: "next", timestamp: 6 },
      ]),
    );
    expect(transcriptItems(view).map((item) => [item.author, item.text])).toEqual([
      ["tool", "Message too large to show (293 KB)."],
      ["you", "next"],
    ]);
    setLocale("fr");
    expect(transcriptItems(view)[0]?.text).toBe("Message trop volumineux pour être affiché (293 Ko).");
  });

  it("rounds a small placeholder up to 1 KB", () => {
    const view = reduceSession(
      EMPTY_VIEW,
      snapshotOf("idle", [{ role: "assistant", timestamp: 5, omitted: true, bytes: 10 }]),
    );
    expect(transcriptItems(view)).toMatchObject([
      { author: "agent", text: "Message too large to show (1 KB)." },
    ]);
  });

  it("shows the summaries of a compaction and a branch, and a visible custom message, as tool lines with their text", () => {
    const view = reduceSession(
      EMPTY_VIEW,
      snapshotOf("idle", [
        { role: "compactionSummary", summary: "what came before", tokensBefore: 90, timestamp: 1 },
        { role: "branchSummary", summary: "the other branch", fromId: "e1", timestamp: 2 },
        { role: "custom", customType: "note", display: true, content: "from an extension", timestamp: 3 },
        { role: "custom", customType: "note", display: false, content: "kept private", timestamp: 4 },
      ]),
    );
    expect(transcriptItems(view)).toEqual([
      { key: "compactionSummary:1", author: "tool", text: "what came before" },
      { key: "branchSummary:2", author: "tool", text: "the other branch" },
      { key: "custom:3", author: "tool", text: "from an extension" },
    ]);
  });
});
