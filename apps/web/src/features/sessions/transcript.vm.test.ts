import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { EMPTY_VIEW, reduceSession } from "../../stores/session-reducer.ts";
import { sessionSnapshot } from "../../testing/session-snapshot.ts";
import { transcriptItems, type TranscriptItem } from "./transcript.vm.ts";

const textOf = (item: TranscriptItem | undefined) => (item && "text" in item ? item.text : undefined);

afterEach(() => setLocale("en"));

const snapshotOf = (status: string, messages: unknown[], patch: Record<string, unknown> = {}) =>
  sessionSnapshot({ status, rows: messages.map((message) => ({ entryId: null, message })), ...patch });

describe("transcriptItems", () => {
  it("maps authors, shows a tool call under its message, and appends the partial reply", () => {
    let view = reduceSession(
      EMPTY_VIEW,
      snapshotOf("running", [
        { role: "user", content: "Run the check", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking" },
            { type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo ok" } },
          ],
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
    expect(transcriptItems(view)).toMatchObject([
      { kind: "message", author: "you", text: "Run the check" },
      { kind: "message", author: "agent", text: "Checking", thinking: "" },
      { kind: "tool", name: "bash", summary: "echo ok", status: "done", preview: "ok\n" },
      { kind: "partial", text: "Done", thinking: "" },
    ]);
  });

  it("keeps the thinking of a message apart from its text", () => {
    const view = reduceSession(
      EMPTY_VIEW,
      snapshotOf("idle", [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me see" },
            { type: "text", text: "Answer" },
          ],
          timestamp: 2,
        },
      ]),
    );
    expect(transcriptItems(view)).toMatchObject([
      { kind: "message", text: "Answer", thinking: "let me see" },
    ]);
  });

  it("shows a compaction as a summary item and the partial reply with its thinking", () => {
    const view = reduceSession(
      EMPTY_VIEW,
      sessionSnapshot({
        rows: [
          {
            entryId: "c1",
            message: { role: "compactionSummary", summary: "earlier work", tokensBefore: 900, timestamp: 1 },
          },
        ],
        partial: {
          blocks: [
            { type: "thinking", text: "hmm" },
            { type: "text", text: "Hel" },
            { type: "toolCall", text: "{}", id: "c1", name: "bash" },
            { type: "text", text: "lo" },
          ],
        },
      }),
    );
    expect(transcriptItems(view)).toEqual([
      {
        kind: "summary",
        key: "compactionSummary:1",
        variant: "compaction",
        text: "earlier work",
        tokensBefore: 900,
        entryId: "c1",
      },
      { kind: "partial", key: "partial", text: "Hello", thinking: "hmm" },
    ]);
  });

  it("shows a branch summary and a visible custom message, and hides a private one", () => {
    const view = reduceSession(
      EMPTY_VIEW,
      snapshotOf("idle", [
        { role: "branchSummary", summary: "the other branch", fromId: "e1", timestamp: 2 },
        { role: "custom", customType: "note", display: true, content: "from an extension", timestamp: 3 },
        { role: "custom", customType: "note", display: false, content: "kept private", timestamp: 4 },
      ]),
    );
    expect(transcriptItems(view)).toEqual([
      {
        kind: "summary",
        key: "branchSummary:2",
        variant: "branch",
        text: "the other branch",
        tokensBefore: null,
        entryId: null,
      },
      {
        kind: "message",
        key: "custom:3",
        author: "tool",
        text: "from an extension",
        thinking: "",
        entryId: null,
      },
    ]);
  });

  it("shows a provider failure as its own item, after whatever the message said", () => {
    const view = reduceSession(
      EMPTY_VIEW,
      snapshotOf("idle", [
        { role: "user", content: "go", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "Starting..." }],
          stopReason: "error",
          errorMessage: "overloaded",
          timestamp: 2,
        },
      ]),
    );
    const items = transcriptItems(view);
    expect(items.map((item) => [item.kind, textOf(item)])).toEqual([
      ["message", "go"],
      ["message", "Starting..."],
      ["failure", "overloaded"],
    ]);
    expect(new Set(items.map((item) => item.key)).size).toBe(3);
  });

  it("words a failure that came without a message", () => {
    const view = reduceSession(
      EMPTY_VIEW,
      snapshotOf("idle", [{ role: "assistant", content: [], stopReason: "error", timestamp: 2 }]),
    );
    expect(transcriptItems(view)).toMatchObject([{ kind: "failure", text: "Something went wrong." }]);
  });

  it("shows an oversize row as an item with its size instead of dropping it, in English and French (R109)", () => {
    const view = reduceSession(
      EMPTY_VIEW,
      snapshotOf("idle", [
        { role: "toolResult", timestamp: 5, omitted: true, bytes: 300_000 },
        { role: "user", content: "next", timestamp: 6 },
      ]),
    );
    expect(
      transcriptItems(view).map((item) => [item.kind === "message" ? item.author : item.kind, textOf(item)]),
    ).toEqual([
      ["tool", "Message too large to show (293 KB)."],
      ["you", "next"],
    ]);
    setLocale("fr");
    expect(textOf(transcriptItems(view)[0])).toBe("Message trop volumineux pour être affiché (293 Ko).");
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
});
