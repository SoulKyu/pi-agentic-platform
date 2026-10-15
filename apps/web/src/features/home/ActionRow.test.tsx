// @vitest-environment happy-dom
import { DEFAULT_HOME_LAYOUT, type HomeLayout } from "@pap/contracts";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useInboxStore } from "../../stores/inbox-store.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { button, click, mount, settle, text } from "../../testing/dom.ts";
import { fakeHomeActions, SHORTCUTS } from "../../testing/home-actions.ts";
import { laneSnapshot } from "../../testing/lane-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellProject } from "../../testing/shell-snapshot.ts";
import { ActionRow } from "./ActionRow.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const api = shellProject({ id: "p1", name: "api", root: "/w/api", sessions: 1 });
const TERMINAL = "A".repeat(22);
let bed: ReturnType<typeof fakeRuntime>;
let actions: ReturnType<typeof fakeHomeActions>;
const show = async (project: typeof api | null = api, layout: HomeLayout = DEFAULT_HOME_LAYOUT) => {
  const page = await mount(
    <ActionRow project={project} layout={layout} actions={actions} shortcuts={SHORTCUTS} />,
  );
  await settle();
  return page.container;
};
const reasonOf = (node: HTMLElement) =>
  document.getElementById(node.getAttribute("aria-describedby") ?? "")?.textContent;

beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["files.list"] = () => ({ entries: [], truncated: false });
  bed.handlers["terminal.create"] = () => ({ terminalId: TERMINAL });
  actions = fakeHomeActions();
  useLaneStore.getState().reset();
  useLaneStore.getState().apply(laneSnapshot([], [], 2));
  useInboxStore.getState().reset();
  useInboxStore.getState().apply({ kind: "counts", unread: 3, toHandle: 0 });
});

describe("the action row (§3.2)", () => {
  it("shows four labelled groups and their buttons", async () => {
    const container = await show();
    const groups = [...container.querySelectorAll("[data-home-actions] section")].map((section) => [
      section.querySelector("h2")?.textContent,
      [...section.querySelectorAll("button")].map(
        (node) => node.getAttribute("aria-label") ?? node.textContent,
      ),
    ]);
    expect(groups).toEqual([
      ["Explore", ["Files", "Terminal", "Search"]],
      ["Automate", ["Tasks", "Inbox, 3 unread"]],
      ["Project", ["Archived lanes (2)", "Project settings"]],
      ["Help", ["Keyboard shortcuts"]],
    ]);
    expect(container.querySelector("[data-home-actions] h2")?.className).toContain("label-hud");
  });

  it("shows a shortcut as a hint where there is one, and the unread count on Inbox", async () => {
    const container = await show();
    expect(text(button(container, "Search"))).toBe("SearchCtrl+K");
    expect(text(button(container, "Keyboard shortcuts"))).toBe("Keyboard shortcuts?");
    expect(text(button(container, "Inbox, 3 unread"))).toContain("3");
  });

  it("opens Files in the root, Search for the project, Tasks, the Inbox, the tree and the shortcuts", async () => {
    const container = await show();
    for (const name of [
      "Files",
      "Search",
      "Tasks",
      "Inbox, 3 unread",
      "Archived lanes (2)",
      "Keyboard shortcuts",
    ])
      await click(button(container, name));
    expect(actions.open.mock.calls).toEqual([[{ kind: "files", root: "/w/api" }], [{ kind: "tasks" }]]);
    expect(actions.openSearch).toHaveBeenCalledExactlyOnceWith("p1");
    expect(actions.openInbox).toHaveBeenCalledOnce();
    expect(actions.openTree).toHaveBeenCalledOnce();
    expect(actions.openShortcuts).toHaveBeenCalledOnce();
  });

  it("starts a terminal in the root and opens it", async () => {
    const container = await show();
    await click(button(container, "Terminal"));
    await settle();
    expect(bed.called("terminal.create")[0]?.params).toMatchObject({ cwd: "/w/api", cols: 80, rows: 24 });
    expect(actions.open).toHaveBeenCalledExactlyOnceWith({ kind: "terminal", id: TERMINAL });
  });

  it("shows a failed start as a notice, keeps Terminal enabled, and a second click retries (PH12)", async () => {
    const container = await show();
    bed.handlers["terminal.create"] = () => {
      throw new RpcError("capacity");
    };
    await click(button(container, "Terminal"));
    await settle();
    expect(button(container, "Terminal").disabled).toBe(false);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "The server is at capacity. Try again later.",
    );
    bed.handlers["terminal.create"] = () => ({ terminalId: TERMINAL });
    await click(button(container, "Terminal"));
    await settle();
    expect(bed.called("terminal.create")).toHaveLength(2);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(actions.open).toHaveBeenCalledExactlyOnceWith({ kind: "terminal", id: TERMINAL });
  });

  it("starts one terminal for a double click", async () => {
    const container = await show();
    const terminal = button(container, "Terminal");
    await act(async () => {
      terminal.click();
      terminal.click();
    });
    await settle();
    expect(bed.called("terminal.create")).toHaveLength(1);
    expect(actions.open).toHaveBeenCalledOnce();
  });

  it("does not check the root when the Explore group is hidden", async () => {
    await show(api, { ...DEFAULT_HOME_LAYOUT, explore: false });
    expect(bed.called("files.list")).toEqual([]);
  });

  it("disables Files and Terminal with their reason when the workspace refuses the root (PH12)", async () => {
    bed.handlers["files.list"] = () => {
      throw new RpcError("not_found");
    };
    const container = await show();
    expect(bed.called("files.list")[0]?.params).toEqual({ path: "/w/api" });
    for (const name of ["Files", "Terminal"]) {
      expect(button(container, name).disabled).toBe(true);
      expect(reasonOf(button(container, name))).toBe("pap cannot open this folder.");
    }
    expect(button(container, "Search").disabled).toBe(false);
  });

  it("keeps Files and Terminal open when the check itself fails (an unknown fact never disables)", async () => {
    bed.handlers["files.list"] = () => {
      throw new RpcError("timeout");
    };
    const container = await show();
    expect(button(container, "Files").disabled).toBe(false);
  });

  it("says Choose a project first under All projects, and the global actions work (PH13)", async () => {
    const container = await show(null);
    for (const name of ["Files", "Terminal"])
      expect(reasonOf(button(container, name))).toBe("Choose a project first.");
    await click(button(container, "Search"));
    expect(actions.openSearch).toHaveBeenCalledExactlyOnceWith(null);
    expect(bed.called("files.list")).toEqual([]);
  });

  it("Project settings links to Skills and trust, MCP servers and Approvals (PH9)", async () => {
    const container = await show();
    await click(button(container, "Project settings"));
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull(), {
      timeout: 2_000,
    });
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual(["Skills and trust", "MCP servers", "Approvals"]);
    await click(items[1] as HTMLElement);
    expect(actions.open).toHaveBeenCalledExactlyOnceWith({ kind: "settings", section: "mcp" });
  });

  it("hides each group Settings › Appearance › Home hides, and itself when all are (§6)", async () => {
    const container = await show(api, { ...DEFAULT_HOME_LAYOUT, explore: false, help: false });
    expect([...container.querySelectorAll("[data-home-actions] h2")].map((node) => node.textContent)).toEqual(
      ["Automate", "Project"],
    );
    const rest = await show(api, { ...DEFAULT_HOME_LAYOUT, automate: false, project: false });
    expect([...rest.querySelectorAll("[data-home-actions] h2")].map((node) => node.textContent)).toEqual([
      "Explore",
      "Help",
    ]);
    const none = await show(api, {
      ...DEFAULT_HOME_LAYOUT,
      explore: false,
      automate: false,
      project: false,
      help: false,
    });
    expect(none.querySelector("[data-home-actions]")).toBeNull();
  });
});
