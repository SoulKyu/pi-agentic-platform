// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "@pap/ui";
import { setLocale } from "../../i18n/index.ts";
import { RpcError } from "../../runtime/rpc.ts";
import { useInboxStore } from "../../stores/inbox-store.ts";
import { button, click, settle, text, type Mounted } from "../../testing/dom.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { current, itemOf, loadInbox, newBed, NOW, show } from "./inbox-bed.tsx";
import InboxPanel from "./InboxPanel.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let page: Mounted | null = null;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  await page?.unmount();
  page = null;
  vi.useRealTimers();
  useInboxStore.getState().reset();
  setLocale("en");
});

const rows = () => [...document.querySelectorAll<HTMLElement>('[data-slot="inbox-row"]')];

const mixed = () =>
  loadInbox([
    itemOf({
      id: "d1",
      kind: "task_done",
      toHandle: false,
      triggerName: "nightly",
      createdAt: NOW - 60_000,
      costUsd: 0.31,
    }),
    itemOf({ id: "q1", triggerName: "prod-alerts", readAt: NOW - 1 }),
    itemOf({
      id: "f1",
      kind: "task_failed",
      toHandle: false,
      triggerName: "feed",
      createdAt: NOW - 3_600_000 * 3,
      costUsd: null,
    }),
  ]);

describe("InboxPanel", () => {
  it("heads the list with the to-handle count and puts the rows to handle first, on the attention tint", async () => {
    newBed();
    mixed();
    page = await show(<InboxPanel onOpenSession={() => {}} />);
    expect(page.container.querySelector("[data-inbox-panel]")).not.toBeNull();
    expect(text(page.container)).toContain("Inbox · 1 to handle");
    expect(rows().map((row) => row.dataset["itemId"])).toEqual(["q1", "d1", "f1"]);
    expect(rows()[0]?.className).toContain("bg-attn-tint");
    expect(rows()[1]?.className).not.toContain("bg-attn-tint");
  });

  it("shows the title, the kind chip, the relative time and the cost of a row", async () => {
    newBed();
    mixed();
    page = await show(<InboxPanel onOpenSession={() => {}} />);
    const done = rows()[1] as HTMLElement;
    expect(done.textContent).toContain("nightly · finished");
    expect(done.querySelector('[data-slot="chip"]')?.textContent).toBe("Done");
    expect(done.textContent).toContain("1 min");
    expect(done.textContent).toContain("$0.31");
    const failed = rows()[2] as HTMLElement;
    expect(failed.textContent).toContain("3 h");
    expect(failed.textContent).not.toContain("$");
  });

  it("filters to the rows to handle, and to the task rows", async () => {
    newBed();
    mixed();
    page = await show(<InboxPanel onOpenSession={() => {}} />);
    const items = () => [...document.querySelectorAll<HTMLElement>('[data-slot="segmented"] button')];
    expect(items().map((one) => one.textContent)).toEqual(["All", "To handle", "Replies", "Tasks"]);
    await click(button(page.container, "To handle"));
    expect(rows().map((row) => row.dataset["itemId"])).toEqual(["q1"]);
    await click(button(page.container, "Tasks"));
    expect(rows()).toHaveLength(3);
    await click(button(page.container, "All"));
    expect(rows()).toHaveLength(3);
  });

  it("sends markRead {all: true} with a commandId from Read all", async () => {
    const bed = newBed();
    bed.handlers["inbox.markRead"] = () => ({ updated: 2 });
    mixed();
    page = await show(<InboxPanel onOpenSession={() => {}} />);
    await click(button(page.container, "Read all"));
    const [call] = bed.called("inbox.markRead");
    expect(call?.params).toEqual({ all: true });
    expect(call?.options?.commandId).toMatch(/^bed-cmd-/);
  });

  it("says a refusal of Read all with a fixed text", async () => {
    const bed = newBed();
    bed.handlers["inbox.markRead"] = () => {
      throw new RpcError("read_only");
    };
    mixed();
    page = await show(<InboxPanel onOpenSession={() => {}} />);
    await click(button(page.container, "Read all"));
    await settle();
    expect(page.container.querySelector('[role="alert"]')?.textContent).toBe(
      "The database was written by a newer pap and is read-only.",
    );
    expect(page.container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("opens the session of a clicked row and marks that row read", async () => {
    const bed = newBed();
    bed.handlers["inbox.markRead"] = () => ({ updated: 1 });
    loadInbox([itemOf({ id: "q1", sessionId: "sess-9" })]);
    const opened = vi.fn();
    page = await show(<InboxPanel onOpenSession={opened} />);
    await click(rows()[0] as HTMLElement);
    expect(opened).toHaveBeenCalledWith("sess-9");
    const [call] = bed.called("inbox.markRead");
    expect(call?.params).toEqual({ ids: ["q1"] });
    expect(call?.options?.commandId).toMatch(/^bed-cmd-/);
  });

  it("shows a toast when marking a clicked row read fails, and still opens the session", async () => {
    const bed = newBed();
    bed.handlers["inbox.markRead"] = () => {
      throw new RpcError("internal");
    };
    loadInbox([itemOf({ id: "q1", sessionId: "sess-9" })]);
    const opened = vi.fn();
    page = await show(
      <>
        <InboxPanel onOpenSession={opened} />
        <Toaster closeLabel="Close toast" regionLabel="Notifications" />
      </>,
    );
    await click(rows()[0] as HTMLElement);
    await settle();
    expect(opened).toHaveBeenCalledWith("sess-9");
    expect([...document.querySelectorAll('[data-slot="toast"]')].map((node) => node.textContent)).toEqual([
      expect.stringContaining("Could not mark the items read. Try again."),
    ]);
  });

  it("makes a row a real button, and leaves a read row without a session alone", async () => {
    const bed = newBed();
    loadInbox([itemOf({ id: "q1", sessionId: null, readAt: NOW - 1 })]);
    const opened = vi.fn();
    page = await show(<InboxPanel onOpenSession={opened} />);
    const row = rows()[0] as HTMLElement;
    expect(row.tagName).toBe("BUTTON");
    expect(row.getAttribute("type")).toBe("button");
    await click(row);
    expect(opened).not.toHaveBeenCalled();
    expect(bed.called("inbox.markRead")).toHaveLength(0);
  });

  it("renders a hostile trigger name as text", async () => {
    newBed();
    loadInbox([itemOf({ triggerName: "<img src=x onerror=alert(1)>\u202e" })]);
    page = await show(<InboxPanel onOpenSession={() => {}} />);
    expect(page.container.querySelector("img")).toBeNull();
    expect(text(page.container)).toContain("<img src=x onerror=alert(1)>\\u202E");
  });

  it("shows the empty state, and the filter's own when nothing is to handle", async () => {
    newBed();
    loadInbox([]);
    page = await show(<InboxPanel onOpenSession={() => {}} />);
    expect(page.container.querySelector('[data-slot="empty-state"]')?.textContent).toContain(
      "Nothing waits for you",
    );
    expect(rows()).toHaveLength(0);
    await page.unmount();
    loadInbox([itemOf({ id: "d1", kind: "task_done", toHandle: false })]);
    page = await show(<InboxPanel onOpenSession={() => {}} />);
    await click(button(page.container, "To handle"));
    expect(page.container.querySelector('[data-slot="empty-state"]')?.textContent).toContain(
      "Nothing to handle",
    );
  });

  it("says when the snapshot kept only the most recent items, and reads in French", async () => {
    newBed();
    loadInbox([itemOf()], { truncated: true });
    setLocale("fr");
    page = await show(<InboxPanel onOpenSession={() => {}} />);
    expect(text(page.container)).toContain("Boîte · 1 à traiter");
    expect(text(page.container)).toContain("Seuls les éléments les plus récents sont listés.");
    expect(button(page.container, "Tout lire")).not.toBeNull();
  });
});

describe("agent rows in the panel (M11R129)", () => {
  const agentRows = () => {
    useAgentsStore.getState().reset();
    useAgentsStore.getState().apply({
      kind: "snapshot",
      agents: [
        {
          id: "atlas-1a2b",
          name: "Atlas",
          initials: "AT",
          state: "idle",
          unread: 0,
          paused: false,
          quarantined: false,
          unreadable: false,
          threadSessionId: "s1",
          lastActivityAt: 1,
        },
      ],
      requests: [],
      truncated: false,
    });
    loadInbox([
      itemOf({ id: "task", kind: "task_done", toHandle: false, createdAt: NOW - 1000 }),
      itemOf({
        id: "rep",
        kind: "agent_reply",
        toHandle: false,
        agentId: "atlas-1a2b",
        refId: null,
        taskId: null,
        sessionId: null,
        entryId: "e7",
        detail: "Done for today",
        createdAt: NOW - 2000,
      }),
      itemOf({
        id: "app",
        kind: "agent_approve",
        agentId: "atlas-1a2b",
        refId: "req-1",
        taskId: null,
        sessionId: null,
        detail: "Deploy?",
        createdAt: NOW - 9000,
      }),
    ]);
  };

  it("lists the agent rows with the to-handle one first, and filters Replies", async () => {
    newBed();
    agentRows();
    page = await show(<InboxPanel onOpenSession={() => {}} />);
    expect(rows().map((row) => row.dataset["itemId"])).toEqual(["app", "task", "rep"]);
    expect(button(page.container, "Approve")).not.toBeNull();
    await click(button(page.container, "Replies"));
    expect(rows().map((row) => row.dataset["itemId"])).toEqual(["rep"]);
    await click(button(page.container, "Tasks"));
    expect(rows().map((row) => row.dataset["itemId"])).toEqual(["task"]);
  });

  it("opens the agent at the entry and marks the row read when a reply is clicked", async () => {
    const bed = newBed();
    bed.handlers["inbox.markRead"] = () => ({ updated: 1 });
    agentRows();
    const onOpenAgent = vi.fn();
    page = await show(<InboxPanel onOpenSession={() => {}} onOpenAgent={onOpenAgent} />);
    await click(rows().find((row) => row.dataset["itemId"] === "rep") as HTMLElement);
    expect(onOpenAgent).toHaveBeenCalledWith("atlas-1a2b", "e7");
    expect(bed.called("inbox.markRead")[0]?.params).toEqual({ ids: ["rep"] });
  });

  it("shows the Replies empty state with its own words", async () => {
    newBed();
    loadInbox([itemOf({ id: "d1", kind: "task_done", toHandle: false })]);
    page = await show(<InboxPanel onOpenSession={() => {}} />);
    await click(button(page.container, "Replies"));
    expect(page.container.querySelector('[data-slot="empty-state"]')?.textContent).toContain("No replies");
  });
});
