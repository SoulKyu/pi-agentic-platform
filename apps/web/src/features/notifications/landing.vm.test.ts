import { PUSH_ID } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { EMPTY_INBOX, type InboxView } from "../../stores/inbox-reducer.ts";
import { EMPTY_SHELL, type ShellView } from "../../stores/shell-reducer.ts";
import { itemOf } from "../../testing/landing-bed.tsx";
import { shellSession } from "../../testing/shell-snapshot.ts";
import { isOpenPath, landingSegmentOf } from "./landing-path.ts";
import { destinationOf, verdictOf } from "./landing.vm.ts";

const ID = "abcdefghijklmnopqrstuv";

describe("landingSegmentOf and isOpenPath", () => {
  it("reads the one segment of /n/<segment>", () => {
    expect(landingSegmentOf(`/n/${ID}`)).toBe(ID);
    expect(landingSegmentOf("/n/short")).toBe("short");
    for (const path of ["/", "/n", "/n/", `/n/${ID}/x`, "/s/abc", `//n/${ID}`, "https://evil.example"])
      expect(landingSegmentOf(path), path).toBeNull();
  });

  it("opens only /n/ followed by exactly the contracts' push id", () => {
    expect(isOpenPath(`/n/${ID}`)).toBe(true);
    expect(isOpenPath(`/n/${ID.replace("a", "-")}`)).toBe(true);
    for (const path of [
      "https://evil.example",
      "//evil",
      "/auth/x",
      "/n/short",
      `/n/${ID}x`,
      `/n/${ID}/`,
      `/n/${ID}?x=1`,
      `/n/${ID}#x`,
      `/n/${ID.slice(1)}!`,
      `/n/${ID}\n`,
      "/",
    ])
      expect(isOpenPath(path), path).toBe(false);
  });

  it("uses the same rule as the contracts for the id", () => {
    for (const id of [
      ID,
      "A_-0123456789abcdefgh",
      "abcdefghijklmnopqrstu",
      `${ID}w`,
      "abcdefghijklmnopqrst!v",
    ])
      expect(isOpenPath(`/n/${id}`), id).toBe(PUSH_ID.test(id));
  });
});

describe("destinationOf", () => {
  it("maps each target kind", () => {
    expect(destinationOf({ kind: "session", id: "s1" })).toEqual({ kind: "session", id: "s1" });
    expect(destinationOf({ kind: "agent", id: "helper-1a2b" })).toEqual({ kind: "agent", id: "helper-1a2b" });
    expect(destinationOf({ kind: "settings", id: "automation" })).toEqual({
      kind: "settings",
      section: "automation",
    });
    expect(destinationOf({ kind: "settings", id: "notifications" })).toEqual({
      kind: "settings",
      section: "notifications",
    });
    expect(destinationOf({ kind: "settings", id: null })).toEqual({
      kind: "settings",
      section: "notifications",
    });
    expect(destinationOf({ kind: "inbox", id: "q1" })).toEqual({ kind: "inbox", itemId: "q1" });
    expect(destinationOf({ kind: "inbox", id: null })).toEqual({ kind: "inbox", itemId: null });
  });

  it("refuses a session or an agent without an id, and a settings section it does not know", () => {
    for (const target of [
      { kind: "session", id: null },
      { kind: "agent", id: "" },
      { kind: "settings", id: "account" },
      { kind: "settings", id: "../x" },
      { kind: "settings", id: "constructor" },
    ] as const)
      expect(destinationOf(target), JSON.stringify(target)).toBeNull();
  });
});

const inbox = (over: Partial<InboxView>): InboxView => ({ ...EMPTY_INBOX, loaded: true, ...over });
const shell = (over: Partial<ShellView>): ShellView => ({ ...EMPTY_SHELL, loaded: true, ...over });
const sessions = (...list: ReturnType<typeof shellSession>[]) =>
  new Map(list.map((session) => [session.id, session]));

describe("verdictOf", () => {
  it("waits for the stream a verdict needs", () => {
    const stores = { inbox: EMPTY_INBOX, shell: EMPTY_SHELL };
    expect(verdictOf({ kind: "inbox", itemId: "q1" }, stores)).toBe("wait");
    expect(verdictOf({ kind: "session", id: "s1" }, stores)).toBe("wait");
  });

  it("opens targets that carry no question without waiting", () => {
    const stores = { inbox: EMPTY_INBOX, shell: EMPTY_SHELL };
    expect(verdictOf({ kind: "agent", id: "helper-1a2b" }, stores)).toBe("open");
    expect(verdictOf({ kind: "settings", section: "automation" }, stores)).toBe("open");
    expect(verdictOf({ kind: "inbox", itemId: null }, stores)).toBe("open");
  });

  it("calls an Inbox question that was answered handled, and one still open open", () => {
    const answered = itemOf({ id: "q1", resolvedAt: 5, resolution: "answered" });
    const waiting = itemOf({ id: "q2" });
    const stores = { inbox: inbox({ items: [answered, waiting] }), shell: EMPTY_SHELL };
    expect(verdictOf({ kind: "inbox", itemId: "q1" }, stores)).toBe("handled");
    expect(verdictOf({ kind: "inbox", itemId: "q2" }, stores)).toBe("open");
  });

  it("opens an informational Inbox item whether or not it was read", () => {
    const done = itemOf({ id: "d1", kind: "task_done", toHandle: false, readAt: 3 });
    expect(
      verdictOf({ kind: "inbox", itemId: "d1" }, { inbox: inbox({ items: [done] }), shell: EMPTY_SHELL }),
    ).toBe("open");
  });

  it("calls an item the loaded Inbox no longer holds handled", () => {
    expect(verdictOf({ kind: "inbox", itemId: "gone" }, { inbox: inbox({}), shell: EMPTY_SHELL })).toBe(
      "handled",
    );
    // A truncated view may simply not hold it: open the Inbox and let the person look.
    expect(
      verdictOf({ kind: "inbox", itemId: "gone" }, { inbox: inbox({ truncated: true }), shell: EMPTY_SHELL }),
    ).toBe("open");
  });

  it("calls a session that no longer waits handled, and one that waits open", () => {
    const item = { kind: "session", id: "s1" } as const;
    const stores = (needsInput: boolean) => ({
      inbox: EMPTY_INBOX,
      shell: shell({ sessions: sessions(shellSession({ id: "s1", needsInput })) }),
    });
    expect(verdictOf(item, stores(false))).toBe("handled");
    expect(verdictOf(item, stores(true))).toBe("open");
  });

  it("opens a session the shell view does not hold, or cannot read", () => {
    const item = { kind: "session", id: "s1" } as const;
    expect(verdictOf(item, { inbox: EMPTY_INBOX, shell: shell({}) })).toBe("open");
    expect(verdictOf(item, { inbox: EMPTY_INBOX, shell: shell({ unreadable: true }) })).toBe("open");
    expect(verdictOf(item, { inbox: EMPTY_INBOX, shell: shell({ failed: "forbidden" }) })).toBe("open");
  });
});
