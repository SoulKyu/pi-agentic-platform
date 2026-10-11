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
});
