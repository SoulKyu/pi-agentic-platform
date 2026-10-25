// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLaneStore } from "../../stores/lane-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { button, click, hasButton, settle, text } from "../../testing/dom.ts";
import { menuLabels, openMenu } from "../../testing/menu.ts";
import { shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";
import { current, newBed } from "./lanes-bed.tsx";
import { LAYOUT_KEY, showReview } from "./lane-layout.ts";
import { load, phone, pr, resetLaneScreenBed, show } from "../../testing/lane-screen-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

beforeEach(resetLaneScreenBed);
afterEach(() => vi.unstubAllGlobals());

describe("lane screen: header", () => {
  it("shows the title, the status word with its reason, the facts and the pull request", async () => {
    load({
      title: "Fix the login",
      setup: { state: "failed", exitCode: 1, startedAt: 1, finishedAt: 2 },
      facts: {
        dirty: 1,
        ahead: 3,
        behind: 1,
        unpushed: 3,
        additions: 12,
        deletions: 4,
        checkedAt: 1,
        error: null,
      },
    });
    const content = text((await show()).container);
    expect(content).toContain("Fix the login");
    expect(content).toContain("Needs attention");
    expect(content).toContain("setup failed");
    expect(content).toContain("pi/a-1a2b → main");
    expect(content).toContain("↑3 ↓1");
    expect(content).toContain("+12 −4");
  });

  it("shows the pull request with its checks and conflicts, and the lane in review", async () => {
    load({ pr });
    const content = text((await show()).container);
    expect(content).toContain("In review");
    expect(content).toContain("#7 · open");
    expect(content).toContain("2 checks passed");
    expect(content).toContain("1 check failed");
    expect(content).toContain("conflicts");
  });

  it("marks an issue lane as external content", async () => {
    load({ source: { kind: "issue", forge: "github", url: "https://x/1", number: 1 } });
    expect(text((await show()).container)).toContain("external content");
  });

  it("asks the forge once when the tab opens on a lane with a pull request, and not without one", async () => {
    load({ pr });
    const bed = newBed();
    await show();
    expect(bed.called("lanes.prRefresh")).toHaveLength(1);
    expect(bed.called("lanes.prRefresh")[0]?.params).toEqual({ laneId: "a-1a2b" });
    useLaneStore.getState().reset();
    load();
    const other = newBed();
    await show();
    expect(other.called("lanes.prRefresh")).toHaveLength(0);
  });

  it("shows a pull request error with a Retry that refreshes", async () => {
    load({ pr: { ...pr, error: "not_signed_in" } });
    const bed = newBed();
    const page = await show();
    expect(text(page.container)).toContain("not signed in");
    await click(button(page.container, "Retry"));
    await settle();
    expect(bed.called("lanes.prRefresh")).toHaveLength(2);
  });
});

describe("lane screen: notices", () => {
  it("shows one muted line each, newest first, and dismisses one locally", async () => {
    load({
      notices: [
        { kind: "disk_low", at: 1, count: null },
        { kind: "large_files_skipped", at: 2, count: 3 },
      ],
    });
    const page = await show();
    const lines = [...page.container.querySelectorAll("[data-lane-notice]")].map((node) => node.textContent);
    expect(lines[0]).toContain("3 large files left out of checkpoints");
    expect(lines[1]).toContain("Disk almost full: checkpoints paused");
    await click(page.container.querySelector("[data-lane-notice] button") as Element);
    expect(page.container.querySelectorAll("[data-lane-notice]")).toHaveLength(1);
    expect(text(page.container)).not.toContain("3 large files");
    await page.unmount();
    const again = await show();
    expect(text(again.container)).not.toContain("3 large files");
    expect(text(again.container)).toContain("Disk almost full");
  });

  it("dismissing the first notice keeps the second line's element, and its place", async () => {
    load({
      notices: [
        { kind: "disk_low", at: 1, count: null },
        { kind: "large_files_skipped", at: 2, count: 3 },
      ],
    });
    const page = await show();
    const second = page.container.querySelectorAll("[data-lane-notice]")[1];
    await click(page.container.querySelector("[data-lane-notice] button") as Element);
    expect(page.container.querySelectorAll("[data-lane-notice]")[0]).toBe(second);
    await page.unmount();
  });

  it("a session that could not start offers Start session", async () => {
    load({ notices: [{ kind: "session_failed", at: 1, count: null }] });
    const bed = newBed();
    bed.handlers["lanes.newSession"] = () => ({ sessionId: "sess-9" });
    const page = await show();
    await click(button(page.container, "Start session"));
    await settle();
    expect(bed.called("lanes.newSession")).toHaveLength(1);
  });
});

describe("lane screen: Run setup", () => {
  it("is offered for a pending setup, not for a finished one", async () => {
    load({ setup: { state: "pending", exitCode: null, startedAt: null, finishedAt: null } });
    expect(hasButton((await show()).container, "Run setup")).toBe(true);
    useLaneStore.getState().reset();
    load();
    expect(hasButton((await show()).container, "Run setup")).toBe(false);
  });

  it("says a token created the lane next to Run setup, and only then", async () => {
    const pending = { state: "pending", exitCode: null, startedAt: null, finishedAt: null } as const;
    load({ createdBy: "token", setup: pending });
    expect(text((await show()).container)).toContain("Created by a token");
    useLaneStore.getState().reset();
    load({ createdBy: "session", setup: pending });
    expect(text((await show()).container)).not.toContain("Created by a token");
  });

  it("a tainted answer asks inline, then runs again with confirmTainted", async () => {
    load({ setup: { state: "pending", exitCode: null, startedAt: null, finishedAt: null } });
    const bed = newBed();
    bed.handlers["lanes.runScript"] = () => ({ ok: false, reason: "tainted" });
    const page = await show();
    await click(button(page.container, "Run setup"));
    await settle();
    expect(bed.called("lanes.runScript")[0]?.params).toEqual({ laneId: "a-1a2b", kind: "setup" });
    expect(text(page.container)).toContain("which an agent that read external content may have changed");
    bed.handlers["lanes.runScript"] = () => ({ ok: true });
    await click(button(page.container, "Run anyway"));
    await settle();
    expect(bed.called("lanes.runScript")[1]?.params).toEqual({
      laneId: "a-1a2b",
      kind: "setup",
      confirmTainted: true,
    });
    expect(text(page.container)).not.toContain("external content may have changed");
  });

  it("says why a refused run did not start", async () => {
    load({ setup: { state: "unapproved", exitCode: null, startedAt: null, finishedAt: null } });
    const bed = newBed();
    bed.handlers["lanes.runScript"] = () => ({ ok: false, reason: "unapproved" });
    const page = await show();
    await click(button(page.container, "Run setup"));
    await settle();
    expect(text(page.container)).toContain("The setup script is not approved yet");
  });
});

describe("lane screen: actions and panes", () => {
  it("opens the setup log and the archive dialog", async () => {
    load();
    const bed = newBed();
    bed.handlers["lanes.scriptLog"] = () => ({ text: "log line", nextOffset: null, size: 8, capped: false });
    const page = await show();
    await click(button(page.container, "Setup log"));
    await settle();
    expect(text(document.body)).toContain("log line");
    await click(button(document.body, "Close"));
    await click(button(page.container, "Archive"));
    expect(text(document.body)).toContain("Archive this lane");
  });

  it("New session here starts a session and shows its chat", async () => {
    load();
    const bed = newBed();
    bed.handlers["lanes.newSession"] = () => ({ sessionId: "sess-2" });
    const page = await show();
    expect(page.container.querySelector("[data-chat]")?.getAttribute("data-chat")).toBe("sess-1");
    await click(button(page.container, "New session here"));
    await settle();
    expect(page.container.querySelector("[data-chat]")?.getAttribute("data-chat")).toBe("sess-2");
  });

  it("offers the sessions of the lane in a menu", async () => {
    load();
    useShellStore
      .getState()
      .apply(
        shellSnapshot([
          shellSession({ id: "sess-1", cwd: "/p/worktrees/a-1a2b", name: "First" }),
          shellSession({ id: "sess-3", cwd: "/p/worktrees/a-1a2b/src", name: "Third" }),
          shellSession({ id: "other", cwd: "/p/worktrees/a-1a2b-x", name: "Elsewhere" }),
        ]),
      );
    const page = await show();
    await openMenu(button(page.container, "Lane sessions"));
    expect(menuLabels()).toEqual(["First", "Third"]);
  });

  it("puts the checkpoint banner above the composer through the chat slot", async () => {
    load();
    const bed = newBed();
    bed.handlers["lanes.checkpointStatus"] = () => ({
      target: { entryId: "e", turn: 1 },
      exact: true,
      differs: true,
      undoAvailable: false,
    });
    useSessionStore.setState({
      views: {
        "sess-1": { ...(await import("../../stores/session-reducer.ts")).EMPTY_VIEW, status: "idle" },
      },
    });
    const page = await show();
    expect(page.container.querySelector("[data-chat]")?.textContent).toContain(
      "Files differ from this point",
    );
  });

  it("keeps the right pane and shows review, changes or terminal by the segmented switch", async () => {
    load();
    const page = await show({ review: () => <p>review slot</p>, commitBar: <p>commit bar</p> });
    expect(text(page.container)).toContain("review slot");
    expect(text(page.container)).toContain("commit bar");
    await click(button(page.container, "Changes"));
    expect(text(page.container)).toContain("changes /p/worktrees/a-1a2b");
    await click(button(page.container, "Terminal"));
    expect(text(page.container)).toContain("terminal /p/worktrees/a-1a2b");
    expect(text(page.container)).not.toContain("changes /p");
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}").lanes[0]).toEqual([
      "a-1a2b",
      expect.objectContaining({ right: "terminal" }),
    ]);
    await page.unmount();
    expect(text((await show()).container)).toContain("terminal /p/worktrees/a-1a2b");
  });

  it("fills the commit bar slot with its own bar, under the review", async () => {
    load();
    const bed = newBed();
    const page = await show();
    expect(page.container.querySelector("[data-slot='lane-commit-bar']")).not.toBeNull();
    expect(bed.called("subscribe.vcs")[0]?.params).toMatchObject({ root: "/p/worktrees/a-1a2b" });
  });

  it("switches a lane tab that is already open to Review when the compare tab asks for it", async () => {
    load();
    const page = await show({ review: () => <p>review slot</p> });
    await click(button(page.container, "Changes"));
    expect(text(page.container)).not.toContain("review slot");
    showReview("a-1a2b");
    await settle();
    expect(text(page.container)).toContain("review slot");
    expect(text(page.container)).not.toContain("changes /p");
    showReview("b-1a2b");
    await click(button(page.container, "Changes"));
    expect(text(page.container)).toContain("changes /p/worktrees/a-1a2b");
  });

  it("splits the right pane once more", async () => {
    load();
    const page = await show({ review: () => <p>review slot</p> });
    await click(button(page.container, "Split the pane"));
    expect(text(page.container)).toContain("review slot");
    expect(text(page.container)).toContain("terminal /p/worktrees/a-1a2b");
    await click(button(page.container, "Close the split"));
    expect(text(page.container)).not.toContain("terminal /p");
  });

  it("tells the review slot the lane, its folder and the chat's session, and shows the chat on request", async () => {
    phone(true);
    load();
    const seen = vi.fn();
    const page = await show({
      review: (props: { onOpenChat(id: string): void } & object) => {
        seen(props);
        return <button onClick={() => props.onOpenChat("sess-1")}>to chat</button>;
      },
    });
    await click(button(page.container, "Review"));
    expect(seen).toHaveBeenCalledWith(
      expect.objectContaining({ laneId: "a-1a2b", worktree: "/p/worktrees/a-1a2b", sessionId: "sess-1" }),
    );
    await click(button(page.container, "to chat"));
    expect(text(page.container)).toContain("chat sess-1");
  });

  it("says the review is not there yet when no review slot is given", async () => {
    load();
    expect(text((await show()).container)).toContain("The review of this lane arrives with a later update");
  });
});
