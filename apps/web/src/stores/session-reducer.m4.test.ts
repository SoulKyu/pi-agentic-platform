import { describe, expect, it } from "vitest";
import { sessionSnapshot } from "../testing/session-snapshot.ts";
import { EMPTY_VIEW, reduceSession } from "./session-reducer.ts";

const pi = (event: Record<string, unknown>) => ({ kind: "pi", event });
const entry = (id: string, role: string, messageTimestamp: number) => ({
  kind: "entry",
  entry: { id, parentId: null, type: "message", role, messageTimestamp },
});
const confirm = { id: "d1", method: "confirm", title: "Run a command?", message: "ls" };

describe("reduceSession (M4 carries)", () => {
  it("binds each entry to the oldest message of its name that has none (M4R110)", () => {
    const twin = { role: "user", content: "hi", timestamp: 5 };
    let view = reduceSession(
      EMPTY_VIEW,
      sessionSnapshot({
        rows: [
          { entryId: null, message: twin },
          { entryId: null, message: twin },
        ],
      }),
    );
    view = reduceSession(view, entry("u1", "user", 5));
    view = reduceSession(view, entry("u2", "user", 5));
    expect(view.messages.map((message) => message.entryId)).toEqual(["u1", "u2"]);
  });

  it("lowers the hidden count for an unknown closed dialog, and goes stale when a shown one closes (M4R111)", () => {
    let view = reduceSession(EMPTY_VIEW, sessionSnapshot({ dialogs: [confirm], hiddenDialogs: 2 }));
    view = reduceSession(view, { kind: "dialog_closed", id: "unknown" });
    expect([view.hiddenDialogs, view.staleDialogs, view.dialogs.length]).toEqual([1, false, 1]);
    view = reduceSession(view, { kind: "dialog_closed", id: "d1" });
    expect([view.hiddenDialogs, view.staleDialogs, view.dialogs.length]).toEqual([1, true, 0]);
    view = reduceSession(view, sessionSnapshot());
    expect(view.staleDialogs).toBe(false);
  });

  it("does not go stale when a shown dialog closes and none is hidden", () => {
    const view = reduceSession(reduceSession(EMPTY_VIEW, sessionSnapshot({ dialogs: [confirm] })), {
      kind: "dialog_closed",
      id: "d1",
    });
    expect(view.staleDialogs).toBe(false);
  });

  it("gives the reply being written the key its final message will have (M4R112)", () => {
    let view = reduceSession(
      EMPTY_VIEW,
      pi({ type: "message_start", message: { role: "assistant", timestamp: 7 } }),
    );
    expect(view.partialKey).toBe("assistant:7");
    const final = { role: "assistant", content: [{ type: "text", text: "Hi" }], timestamp: 7 };
    view = reduceSession(view, pi({ type: "message_end", message: final }));
    expect(view.messages.map((message) => message.key)).toEqual(["assistant:7"]);
    expect(view.partialKey).toBeNull();
  });

  it("makes the partial key unique against the list, and the final message takes it", () => {
    const earlier = { role: "assistant", content: [{ type: "text", text: "A" }], timestamp: 7 };
    let view = reduceSession(EMPTY_VIEW, sessionSnapshot({ rows: [{ entryId: null, message: earlier }] }));
    view = reduceSession(view, pi({ type: "message_start", message: { role: "assistant", timestamp: 7 } }));
    expect(view.partialKey).toBe("assistant:7#1");
    const final = { role: "assistant", content: [{ type: "text", text: "B" }], timestamp: 7 };
    view = reduceSession(view, pi({ type: "message_end", message: final }));
    expect(view.messages.map((message) => message.key)).toEqual(["assistant:7", "assistant:7#1"]);
  });

  it("keeps a snapshot's partial on the plain key", () => {
    const view = reduceSession(
      EMPTY_VIEW,
      sessionSnapshot({ partial: { blocks: [{ type: "text", text: "Hi" }] } }),
    );
    expect(view.partialKey).toBeNull();
  });
});
