// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/rpc.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { click, field, press, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellSession } from "../../testing/shell-snapshot.ts";
import {
  HOUR,
  choose,
  closeToasts,
  deferred,
  load,
  menuItems,
  noState,
  openMenu,
  sessionTrigger,
  show,
  toastTexts,
  undoButton,
} from "../../testing/menus-kit.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  useShellStore.getState().reset();
});
afterEach(async () => {
  vi.useRealTimers();
  await closeToasts();
  vi.restoreAllMocks();
});
const marks = () => bed.called("sessions.mark").map((entry) => entry.params);

describe("the row menu", () => {
  it("lists what an active, a pinned, a snoozed and a settled row can do", async () => {
    const now = Date.now();
    await load([
      shellSession({ id: "act", name: "Active", updatedAt: now }),
      shellSession({ id: "p1", name: "First pin", pinRank: 1, updatedAt: now }),
      shellSession({ id: "p2", name: "Middle pin", pinRank: 2, updatedAt: now }),
      shellSession({ id: "p3", name: "Last pin", pinRank: 3, updatedAt: now }),
      shellSession({ id: "zz", name: "Asleep", snoozedUntil: now + HOUR, updatedAt: now }),
      shellSession({ id: "dn", name: "Done", settledAt: now - 5, updatedAt: now }),
    ]);
    const box = await show();
    await openMenu(sessionTrigger(box, "Active"));
    expect(menuItems()).toEqual([
      "Pin",
      "Snooze for 1 hour",
      "Snooze until tomorrow, 9:00",
      "Snooze until next week, Monday 9:00",
      "Snooze until…",
      "Settle",
      "Archive",
    ]);
    await press(document.activeElement as HTMLElement, { key: "Escape" });
    await settle();
    await openMenu(sessionTrigger(box, "First pin"));
    expect(menuItems()).toContain("Unpin");
    expect(menuItems()).toContain("Move down");
    expect(menuItems()).not.toContain("Move up");
    await press(document.activeElement as HTMLElement, { key: "Escape" });
    await settle();
    await openMenu(sessionTrigger(box, "Middle pin"));
    expect(menuItems()).toEqual(expect.arrayContaining(["Unpin", "Move up", "Move down"]));
    await press(document.activeElement as HTMLElement, { key: "Escape" });
    await settle();
    await openMenu(sessionTrigger(box, "Last pin"));
    expect(menuItems()).toContain("Move up");
    expect(menuItems()).not.toContain("Move down");
    await press(document.activeElement as HTMLElement, { key: "Escape" });
    await settle();
    for (const shelf of ["Snoozed (1)", "Settled (1)"])
      await click(
        [...box.querySelectorAll("button[aria-expanded]")].find((b) => b.textContent === shelf) as Element,
      );
    await openMenu(sessionTrigger(box, "Asleep"));
    expect(menuItems()).toContain("Wake now");
    await press(document.activeElement as HTMLElement, { key: "Escape" });
    await settle();
    await openMenu(sessionTrigger(box, "Done"));
    expect(menuItems()).toContain("Unsettle");
    expect(menuItems()).not.toContain("Settle");
  });

  it("sends the snooze presets as local instants worked out when pressed", async () => {
    await load([shellSession({ id: "s1", name: "Fix login" })]);
    const box = await show();
    vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 9, 15, 16, 30).getTime()); // Thursday
    const asked = [
      ["Snooze for 1 hour", new Date(2026, 9, 15, 17, 30)],
      ["Snooze until tomorrow, 9:00", new Date(2026, 9, 16, 9, 0)],
      ["Snooze until next week, Monday 9:00", new Date(2026, 9, 19, 9, 0)],
    ] as const;
    for (const [label, until] of asked) {
      await openMenu(sessionTrigger(box, "Fix login"));
      await choose(label);
      expect(marks().at(-1)).toEqual({
        sessionId: "s1",
        change: { kind: "snooze", until: until.getTime() },
      });
      await act(async () =>
        useShellStore
          .getState()
          .apply({ kind: "session", session: shellSession({ id: "s1", name: "Fix login" }) }),
      );
    }
    expect(marks()).toHaveLength(3);
  });

  it("moves a pin up and down by sending the pin before its new neighbour", async () => {
    await load([
      shellSession({ id: "p1", name: "One", pinRank: 1 }),
      shellSession({ id: "p2", name: "Two", pinRank: 2 }),
      shellSession({ id: "p3", name: "Three", pinRank: 3 }),
    ]);
    const box = await show();
    await openMenu(sessionTrigger(box, "Two"));
    await choose("Move up");
    expect(marks()).toEqual([{ sessionId: "p2", change: { kind: "pin", before: "p1" } }]);
    await openMenu(sessionTrigger(box, "One"));
    await choose("Move down");
    // The order is now Two, One, Three: One moves below Three, to the end.
    expect(marks()[1]).toEqual({ sessionId: "p1", change: { kind: "pin", before: null } });
    // Two, Three, One: Three moves above Two.
    await openMenu(sessionTrigger(box, "Three"));
    await choose("Move up");
    expect(marks()[2]).toEqual({ sessionId: "p3", change: { kind: "pin", before: "p2" } });
  });

  it("Archive moves the row to the Archived shelf at once, toasts it with Undo, and Undo sends a restore", async () => {
    await load([shellSession({ id: "s1", name: "Fix login" })]);
    const box = await show();
    const answer = deferred();
    bed.handlers["sessions.mark"] = () => answer.promise;
    await openMenu(sessionTrigger(box, "Fix login"));
    await choose("Archive");
    expect(box.querySelector("[data-session-label]")).toBeNull();
    expect([...box.querySelectorAll("button[aria-expanded]")].map((b) => b.textContent)).toEqual([
      "Archived (1)",
    ]);
    answer.resolve({ ok: true });
    await settle();
    expect(toastTexts()).toEqual(["Archived · Fix loginUndo"]);
    bed.handlers["sessions.mark"] = async () => ({ ok: true });
    await click(undoButton());
    await settle();
    expect(marks()[1]).toEqual({ sessionId: "s1", change: { kind: "restore", state: noState } });
    expect(useShellStore.getState().view.sessions.get("s1")?.archivedAt).toBeNull();
  });

  it("names an unnamed session by its first words in the toast", async () => {
    await load([shellSession({ id: "s1", preview: "Why does it fail" })]);
    const box = await show();
    await openMenu(sessionTrigger(box, "Why does it fail"));
    await choose("Settle");
    expect(toastTexts()).toEqual(["Settled · Why does it failUndo"]);
  });

  it("a refusal toasts why and the row stays where it was", async () => {
    await load([shellSession({ id: "s1", name: "Fix login" })]);
    const box = await show();
    bed.handlers["sessions.mark"] = async () => {
      throw new RpcError("limit_reached");
    };
    await openMenu(sessionTrigger(box, "Fix login"));
    await choose("Pin");
    expect(toastTexts().at(-1)).toBe("This list is full. Remove an entry first.");
    expect(useShellStore.getState().view.sessions.get("s1")?.pinRank).toBeNull();
    expect(box.querySelector("h3")?.textContent).not.toBe("Pinned");
    // Focus returns to the row's menu button after the action (not left on the page).
    expect(document.activeElement).toBe(sessionTrigger(box, "Fix login"));
  });

  it("focus falls back to the filter when the acted row left the list", async () => {
    await load([shellSession({ id: "s1", name: "Fix login" })]);
    const box = await show();
    await openMenu(sessionTrigger(box, "Fix login"));
    await choose("Settle");
    expect(document.activeElement).toBe(field(box, "Filter sessions"));
  });

  it("focus follows a pinned row to its new place", async () => {
    await load([shellSession({ id: "s1", name: "Fix login" })]);
    const box = await show();
    await openMenu(sessionTrigger(box, "Fix login"));
    await choose("Pin");
    expect(box.querySelector("h3")?.textContent).toBe("Pinned");
    expect(document.activeElement).toBe(sessionTrigger(box, "Fix login"));
  });

  it("an Undo the daemon refuses toasts why", async () => {
    await load([shellSession({ id: "s1", name: "Fix login" })]);
    const box = await show();
    await openMenu(sessionTrigger(box, "Fix login"));
    await choose("Archive");
    bed.handlers["sessions.mark"] = async () => {
      throw new RpcError("limit_reached");
    };
    await click(undoButton());
    await settle();
    expect(toastTexts().at(-1)).toBe("This list is full. Remove an entry first.");
  });

  it("an Undo pressed while another change is saving is sent once that change is answered (RT-34)", async () => {
    await load([shellSession({ id: "s1", name: "Fix login" }), shellSession({ id: "s2", name: "Other" })]);
    const box = await show();
    await openMenu(sessionTrigger(box, "Fix login"));
    await choose("Archive");
    const slow = deferred();
    bed.handlers["sessions.mark"] = () => slow.promise;
    await openMenu(sessionTrigger(box, "Other"));
    await choose("Pin");
    expect(marks()).toHaveLength(2);
    await click(undoButton());
    await settle();
    expect(marks()).toHaveLength(2);
    slow.resolve({ ok: true });
    await act(async () => {
      await vi.waitFor(() => expect(marks()).toHaveLength(3), { timeout: 2000 });
    });
    expect(marks()[2]).toEqual({ sessionId: "s1", change: { kind: "restore", state: noState } });
  });

  it("an unknown outcome toasts, frees the menus at once and reads the list back (RT-03)", async () => {
    await load([shellSession({ id: "s1", name: "Fix login" }), shellSession({ id: "s2", name: "Other" })]);
    const box = await show();
    const off = bed.runtime.subscriptions.subscribe("shell", "me", () => {});
    await settle();
    expect(bed.called("subscribe.shell")).toHaveLength(1);
    bed.handlers["sessions.mark"] = async () => {
      throw new RpcError("connection_lost");
    };
    await openMenu(sessionTrigger(box, "Fix login"));
    await choose("Archive");
    expect(toastTexts()).toEqual(["pap did not answer. The list shows what pap knows as soon as it can."]);
    expect(sessionTrigger(box, "Other").disabled).toBe(false);
    expect(bed.called("subscribe.shell")).toHaveLength(2);
    off();
  });

  it("disables the menus while an answer is pending and says Saving… after 100 ms", async () => {
    await load([shellSession({ id: "s1", name: "Fix login" }), shellSession({ id: "s2", name: "Other" })]);
    const box = await show();
    const slow = deferred();
    bed.handlers["sessions.mark"] = () => slow.promise;
    const region = () => box.querySelector('[role="status"]');
    // Present from the first render, so a screen reader has it before the first message; no visible gap while empty.
    expect(region()?.classList.contains("sr-only")).toBe(true);
    await openMenu(sessionTrigger(box, "Fix login"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent === "Settle");
    await click(item as Element);
    await act(async () => {});
    expect(sessionTrigger(box, "Other").disabled).toBe(true);
    expect(box.querySelector('[role="status"]')?.textContent).toBe("");
    await act(async () => {
      vi.advanceTimersByTime(99);
    });
    expect(box.querySelector('[role="status"]')?.textContent).toBe("");
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(box.querySelector('[role="status"]')?.textContent).toBe("Saving…");
    expect(region()?.classList.contains("sr-only")).toBe(false);
    slow.resolve({ ok: true });
    await act(async () => {});
    expect(sessionTrigger(box, "Other").disabled).toBe(false);
    expect(box.querySelector('[role="status"]')?.textContent).toBe("");
  });

  it("the open Archived shelf gains a row archived from the list, and its title agrees", async () => {
    await load([shellSession({ id: "s1", name: "Fix login" })], { archived: 1 });
    bed.handlers["sessions.listArchived"] = async () => ({
      sessions: [shellSession({ id: "old", name: "Old one", archivedAt: 500, updatedAt: 500 })],
      hasMore: false,
    });
    const box = await show();
    await click(box.querySelector("button[aria-expanded]") as Element);
    await settle();
    expect(box.querySelector("[data-shelf] ul")?.textContent).toContain("Old one");
    await openMenu(sessionTrigger(box, "Fix login"));
    await choose("Archive");
    const shelfRows = [...box.querySelectorAll("[data-shelf] [data-session-label]")].map(
      (row) => row.textContent,
    );
    expect(shelfRows).toEqual(["Fix login", "Old one"]);
    expect(box.querySelector("[data-shelf] button[aria-expanded]")?.textContent).toBe("Archived (2)");
  });
});

describe("the other row actions", () => {
  const click1 = async (box: HTMLElement, row: string, action: string) => {
    await openMenu(sessionTrigger(box, row));
    await choose(action);
  };

  it("Unpin, Wake now, Unsettle and Unarchive each send their change and show it at once", async () => {
    const now = Date.now();
    await load(
      [
        shellSession({ id: "pin", name: "Pinned one", pinRank: 1, updatedAt: now }),
        shellSession({ id: "zz", name: "Asleep", snoozedUntil: now + HOUR, updatedAt: now }),
        shellSession({ id: "dn", name: "Done", settledAt: now - 5, updatedAt: now }),
      ],
      { archived: 1 },
    );
    bed.handlers["sessions.listArchived"] = async () => ({
      sessions: [shellSession({ id: "old", name: "Old one", archivedAt: 500, updatedAt: 500 })],
      hasMore: false,
    });
    const box = await show();
    for (const shelf of ["Snoozed (1)", "Settled (1)", "Archived (1)"])
      await click(
        [...box.querySelectorAll("button[aria-expanded]")].find((b) => b.textContent === shelf) as Element,
      );
    await settle();
    await click1(box, "Pinned one", "Unpin");
    expect(marks().at(-1)).toEqual({ sessionId: "pin", change: { kind: "unpin" } });
    expect(useShellStore.getState().view.sessions.get("pin")?.pinRank).toBeNull();
    expect(toastTexts().at(-1)).toBe("Unpinned · Pinned oneUndo");
    await click1(box, "Asleep", "Wake now");
    expect(marks().at(-1)).toEqual({ sessionId: "zz", change: { kind: "wake" } });
    expect(useShellStore.getState().view.sessions.get("zz")?.snoozedUntil).toBeNull();
    await click1(box, "Done", "Unsettle");
    expect(marks().at(-1)).toEqual({ sessionId: "dn", change: { kind: "unsettle" } });
    expect(useShellStore.getState().view.sessions.get("dn")?.settledAt).toBeNull();
    await openMenu(sessionTrigger(box, "Old one"));
    expect(menuItems()).toEqual(["Unarchive"]);
    await choose("Unarchive");
    expect(marks().at(-1)).toEqual({ sessionId: "old", change: { kind: "unarchive" } });
    // A shelf row the store does not hold is not shown changed before the daemon echoes it.
  });

  it("an Undo still blocked after the wait toasts that another change is saving", async () => {
    await load([shellSession({ id: "s1", name: "Fix login" }), shellSession({ id: "s2", name: "Other" })]);
    const box = await show();
    await click1(box, "Fix login", "Archive");
    const slow = deferred();
    bed.handlers["sessions.mark"] = () => slow.promise;
    await click1(box, "Other", "Pin");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await click(undoButton());
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(toastTexts().at(-1)).toBe("Another change is still being saved. Try again.");
    expect(marks()).toHaveLength(2);
    slow.resolve({ ok: true });
    await act(async () => {});
  });
});
