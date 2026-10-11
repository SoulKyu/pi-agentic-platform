import { describe, expect, it } from "vitest";
import { EMPTY_VIEW, reduceSession } from "./session-reducer.ts";

const user = { role: "user", content: "hi", timestamp: 1 };
const reply = { role: "assistant", content: [{ type: "text", text: "Hello!" }], timestamp: 2 };
const pi = (event: Record<string, unknown>) => ({ kind: "pi", event });

describe("reduceSession", () => {
  it("replaces the view on a snapshot", () => {
    const view = reduceSession(EMPTY_VIEW, {
      kind: "snapshot",
      status: "idle",
      messages: [user],
      dialogs: [],
    });
    expect(view).toMatchObject({
      status: "idle",
      loaded: true,
      messages: [{ key: "user:1", role: "user", text: "hi" }],
    });
  });

  it("keeps the placeholder of an oversize row as a message that says how big it was (R109)", () => {
    const view = reduceSession(EMPTY_VIEW, {
      kind: "snapshot",
      status: "idle",
      messages: [{ role: "toolResult", timestamp: 5, omitted: true, bytes: 300_000 }, user],
      dialogs: [],
    });
    expect(view.messages).toMatchObject([
      { key: "toolResult:5", role: "toolResult", text: "", omittedBytes: 300_000 },
      { key: "user:1", omittedBytes: null },
    ]);
  });

  it("ignores an omitted flag that comes without a size", () => {
    const view = reduceSession(EMPTY_VIEW, {
      kind: "snapshot",
      status: "idle",
      messages: [{ role: "user", content: "hi", timestamp: 1, omitted: true }],
      dialogs: [],
    });
    expect(view.messages[0]).toMatchObject({ text: "hi", omittedBytes: null });
  });

  it("builds a partial reply from text deltas and replaces it on message_end", () => {
    let view = reduceSession(EMPTY_VIEW, pi({ type: "message_start", message: { role: "assistant" } }));
    view = reduceSession(
      view,
      pi({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
      }),
    );
    view = reduceSession(
      view,
      pi({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo!" },
      }),
    );
    expect(view.partialText).toBe("Hello!");
    view = reduceSession(view, pi({ type: "message_end", message: reply }));
    expect(view.partialText).toBeNull();
    expect(view.messages.map((m) => m.text)).toEqual(["Hello!"]);
  });

  it("does not duplicate a message present in both the snapshot and a live event", () => {
    let view = reduceSession(EMPTY_VIEW, {
      kind: "snapshot",
      status: "running",
      messages: [user, reply],
      dialogs: [],
    });
    view = reduceSession(view, pi({ type: "message_end", message: reply }));
    expect(view.messages).toHaveLength(2);
  });

  it("opens a dialog once and closes it", () => {
    const dialog = { id: "d1", method: "confirm", title: "Run a command?", message: "bash: ls" };
    let view = reduceSession(EMPTY_VIEW, { kind: "dialog_open", dialog });
    view = reduceSession(view, { kind: "dialog_open", dialog });
    expect(view.dialogs).toHaveLength(1);
    view = reduceSession(view, { kind: "dialog_closed", id: "d1" });
    expect(view.dialogs).toEqual([]);
  });

  it("turns a status cause into a notice and ignores unknown events", () => {
    const view = reduceSession(EMPTY_VIEW, {
      kind: "status",
      status: "cold",
      cause: "Agent process killed (SIGKILL), possibly out of memory.",
    });
    expect(view.notices).toEqual([
      { level: "error", text: "Agent process killed (SIGKILL), possibly out of memory." },
    ]);
    expect(reduceSession(view, { kind: "future_kind", x: 1 })).toBe(view);
    expect(reduceSession(view, pi({ type: "future_event" }))).toBe(view);
  });

  describe("message identity (R127.3)", () => {
    const call = (id: string) => ({ type: "toolCall", id, name: "bash", arguments: { command: id } });
    const result = (id: string, text: string, timestamp = 7) => ({
      role: "toolResult",
      toolCallId: id,
      content: [{ type: "text", text }],
      timestamp,
    });
    const keysOf = (view: { messages: ReadonlyArray<{ key: string }> }) => view.messages.map((m) => m.key);

    it("keeps every tool result of one turn, though they share a millisecond", () => {
      let view = reduceSession(
        EMPTY_VIEW,
        pi({
          type: "message_end",
          message: { role: "assistant", content: [call("a"), call("b")], timestamp: 6 },
        }),
      );
      view = reduceSession(view, pi({ type: "message_end", message: result("a", "first") }));
      view = reduceSession(view, pi({ type: "message_end", message: result("b", "second") }));
      expect(view.messages.map((m) => m.text)).toEqual(["", "first", "second"]);
      expect(new Set(keysOf(view)).size).toBe(3);
    });

    it("gives a snapshot with same-millisecond results and repeated messages unique keys", () => {
      const view = reduceSession(EMPTY_VIEW, {
        kind: "snapshot",
        status: "idle",
        dialogs: [],
        messages: [
          result("a", "one"),
          result("b", "two"),
          { role: "user", content: "again", timestamp: 9 },
          { role: "user", content: "again!", timestamp: 9 },
          { role: "user", content: "again", timestamp: 9 },
        ],
      });
      expect(view.messages.map((m) => m.text)).toEqual(["one", "two", "again", "again!", "again"]);
      expect(new Set(keysOf(view)).size).toBe(5);
    });

    it("keeps two different messages that share role and millisecond, and still drops a replay", () => {
      const first = { role: "user", content: "one", timestamp: 3 };
      const second = { role: "user", content: "two", timestamp: 3 };
      let view = reduceSession(EMPTY_VIEW, pi({ type: "message_end", message: first }));
      view = reduceSession(view, pi({ type: "message_end", message: second }));
      view = reduceSession(view, pi({ type: "message_end", message: first }));
      view = reduceSession(view, pi({ type: "message_end", message: second }));
      expect(view.messages.map((m) => m.text)).toEqual(["one", "two"]);
      expect(new Set(keysOf(view)).size).toBe(2);
    });

    it("recognises, from the snapshot, a live message that repeats its key", () => {
      const message = result("a", "once");
      let view = reduceSession(EMPTY_VIEW, {
        kind: "snapshot",
        status: "running",
        messages: [message],
        dialogs: [],
      });
      view = reduceSession(view, pi({ type: "message_end", message }));
      expect(view.messages).toHaveLength(1);
    });
  });

  describe("provider failures (R127.4)", () => {
    const failed = (errorMessage?: string) => ({
      role: "assistant",
      content: [],
      stopReason: "error",
      ...(errorMessage === undefined ? {} : { errorMessage }),
      timestamp: 4,
    });

    it("carries the error message of an assistant message that ended in error", () => {
      const view = reduceSession(
        EMPTY_VIEW,
        pi({ type: "message_end", message: failed("429 usage limit reached") }),
      );
      expect(view.messages[0]).toMatchObject({
        role: "assistant",
        text: "",
        error: "429 usage limit reached",
      });
    });

    it("clips a very long error message", () => {
      const view = reduceSession(EMPTY_VIEW, pi({ type: "message_end", message: failed("x".repeat(5_000)) }));
      const error = view.messages[0]?.error ?? "";
      expect(error.length).toBeLessThanOrEqual(501);
      expect(error.endsWith("…")).toBe(true);
    });

    it("flags a failure that came without a message, and leaves other stop reasons alone", () => {
      expect(
        reduceSession(EMPTY_VIEW, pi({ type: "message_end", message: failed() })).messages[0]?.error,
      ).toBe("");
      for (const stopReason of ["stop", "aborted", "toolUse", "length"]) {
        const message = { ...reply, stopReason, errorMessage: "ignored", timestamp: 8 };
        expect(
          reduceSession(EMPTY_VIEW, pi({ type: "message_end", message })).messages[0]?.error,
          stopReason,
        ).toBeNull();
      }
    });

    it("finds the failure in a snapshot too", () => {
      const view = reduceSession(EMPTY_VIEW, {
        kind: "snapshot",
        status: "idle",
        messages: [user, failed("boom")],
        dialogs: [],
      });
      expect(view.messages.map((m) => m.error)).toEqual([null, "boom"]);
    });
  });

  it("drops a half-written reply when the session goes cold", () => {
    let view = reduceSession(EMPTY_VIEW, pi({ type: "message_start", message: { role: "assistant" } }));
    view = reduceSession(
      view,
      pi({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Half a sen" } }),
    );
    expect(view.partialText).toBe("Half a sen");
    expect(reduceSession(view, { kind: "status", status: "running" }).partialText).toBe("Half a sen");
    expect(reduceSession(view, { kind: "status", status: "cold" }).partialText).toBeNull();
  });
});
