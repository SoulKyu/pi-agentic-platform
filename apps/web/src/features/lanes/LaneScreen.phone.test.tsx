// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLaneStore } from "../../stores/lane-store.ts";
import { button, click, hasButton, settle, text } from "../../testing/dom.ts";
import { laneSnapshot, laneView } from "../../testing/lane-fixtures.ts";
import { current, newBed } from "./lanes-bed.tsx";
import { load, opened, phone, pr, resetLaneScreenBed, show } from "../../testing/lane-screen-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

beforeEach(resetLaneScreenBed);
afterEach(() => vi.unstubAllGlobals());

describe("lane screen: phone", () => {
  it("shows one pane at a time, switched by Chat / Review / Term", async () => {
    phone(true);
    load();
    const page = await show({ review: () => <p>review slot</p> });
    expect(text(page.container)).toContain("chat sess-1");
    expect(text(page.container)).not.toContain("review slot");
    await click(button(page.container, "Review"));
    expect(text(page.container)).toContain("review slot");
    expect(text(page.container)).not.toContain("chat sess-1");
    await click(button(page.container, "Term"));
    expect(text(page.container)).toContain("terminal /p/worktrees/a-1a2b");
    await click(button(page.container, "Chat"));
    expect(text(page.container)).toContain("chat sess-1");
  });

  it("shrinks the header to branch, status, ahead and PR, with the actions in a sheet", async () => {
    phone(true);
    load({
      facts: {
        dirty: 0,
        ahead: 2,
        behind: 0,
        unpushed: 0,
        additions: 1,
        deletions: 1,
        checkedAt: 1,
        error: null,
      },
      pr,
    });
    const page = await show();
    const header = text(page.container.querySelector("header") as Element);
    expect(header).toContain("pi/a-1a2b");
    expect(header).toContain("↑2");
    expect(header).toContain("#7");
    expect(header).not.toContain("+1 −1");
    expect(hasButton(page.container, "Archive")).toBe(false);
    await click(button(page.container, "Lane actions"));
    await settle();
    expect(hasButton(document.body, "Archive")).toBe(true);
    expect(hasButton(document.body, "Setup log")).toBe(true);
  });
});

describe("lane screen: a lane the store lacks", () => {
  it("says it was archived and points to the archived list", async () => {
    useLaneStore.getState().apply(laneSnapshot([], [], 1));
    const page = await show();
    expect(text(page.container)).toContain("This lane was archived");
    await click(button(page.container, "Archived lanes"));
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("keeps the 'Branch kept' notice after the archive answer unmounts the dialog (N1)", async () => {
    load();
    const bed = newBed();
    bed.handlers["lanes.archive"] = () => {
      // The daemon publishes the archived lane before it answers.
      useLaneStore
        .getState()
        .apply({ kind: "lane", lane: laneView({ id: "a-1a2b", state: "archived", archivedAt: 5 }) });
      return { ok: true, branchDeleted: false };
    };
    const page = await show();
    await click(button(page.container, "Archive"));
    await click(button(document.querySelector('[role="dialog"]') as Element, "Archive"));
    await settle();
    expect(text(page.container)).toContain("This lane was archived");
    expect(text(page.container)).toContain(
      "Branch pi/a-1a2b kept: it has commits that are neither merged nor pushed",
    );
  });

  it("says the lanes did not load, with Retry, when the stream failed", async () => {
    useLaneStore.getState().fail("capacity");
    const page = await show();
    expect(text(page.container)).toContain("Lanes did not load");
    expect(hasButton(page.container, "Retry")).toBe(true);
  });
});
