// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { registerCommand, startKeybindings } from "../../features/commands/index.ts";
import { itemOf } from "../../features/inbox/inbox-bed.tsx";
import { activeTab, EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { click, press, settle, typeInto } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { RpcError } from "../../runtime/rpc.ts";
import { shellProject, shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { useFocusEntry } from "../../stores/focus-entry.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("./HomePane.tsx", async () => {
  const { createElement } = await import("react");
  return { HomePane: () => createElement("p", { "data-stub": "home" }) };
});
vi.mock("../../features/sessions/SessionScreen.tsx", async () => {
  const { createElement } = await import("react");
  return { SessionScreen: () => createElement("p", { "data-stub": "session", tabIndex: 0 }) };
});

const session = (id: string, cwd: string, updatedAt: number, status: "idle" | "running" = "idle") =>
  shellSession({ id, cwd, status, updatedAt });
/** The first event of the shell stream, as the server sends it once the page is connected. */
const feed = (sessions: ReturnType<typeof session>[], patch: Parameters<typeof shellSnapshot>[1] = {}) =>
  act(async () => bed.emitTo("subscribe.shell", shellSnapshot(sessions, patch)));

/** The rail and the rows open menus: their chunk loads before the page mounts. */
const withMenu = (path: string, options: Parameters<typeof renderShell>[1] = {}) =>
  renderShell(path, { chunks: ["menu"], ...options });

let bed: ReturnType<typeof fakeRuntime>;
let started: Array<{ stop(): void }> = [];
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
});
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useShellStore.getState().reset();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const ctrlB = () => press(document.body, { key: "b", code: "KeyB", ctrlKey: true });
const opened = (title: string) =>
  vi.waitFor(() => expect(dialog()?.querySelector("h2")?.textContent).toBe(title), { timeout: 2_000 });

describe("tree drawer", () => {
  it("Escape in the project rename field cancels the edit and keeps the drawer open; elsewhere it closes it", async () => {
    const page = await withMenu("/");
    await settle();
    await feed([shellSession({ id: "one", projectId: "api", updatedAt: 1 })], {
      projects: [shellProject({ id: "api", name: "api", sessions: 1 })],
    });
    await ctrlB();
    await opened("Sessions");
    await vi.waitFor(() => expect(dialog()?.querySelector("[data-project-tree]")).not.toBeNull(), {
      timeout: 2_000,
    });
    await click(dialog()?.querySelector('button[aria-label="Project actions"]') as Element);
    await vi.waitFor(() => expect(document.querySelector('[role="menuitem"]')).not.toBeNull(), {
      timeout: 2_000,
    });
    const rename = [...document.querySelectorAll('[role="menuitem"]')].find(
      (i) => i.textContent === "Rename",
    );
    await click(rename as Element);
    await settle();
    const input = dialog()?.querySelector("[data-inline-edit] input") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    await press(input, { key: "Escape" });
    await settle();
    expect(dialog()).not.toBeNull();
    expect(dialog()?.querySelector("[data-inline-edit]")).toBeNull();
    // Escape outside an edit closes the drawer (a tooltip on the focused button may take the first one).
    for (let tries = 0; tries < 2 && dialog() !== null; tries++) {
      await press(document.activeElement as HTMLElement, { key: "Escape" });
      await settle();
    }
    expect(dialog()).toBeNull();
    await page.unmount();
  });

  it("is not in the document until opened, then Ctrl+B lists the sessions grouped by project", async () => {
    const page = await withMenu("/");
    await settle();
    await feed(
      [
        shellSession({ id: "one", projectId: "api", updatedAt: 1 }),
        shellSession({ id: "two", projectId: "api", updatedAt: 2, status: "running" }),
      ],
      { projects: [shellProject({ id: "api", name: "api", sessions: 2 })] },
    );
    expect(dialog()).toBeNull();
    await ctrlB();
    await opened("Sessions");
    await vi.waitFor(() => expect(dialog()?.querySelector("[data-project-tree]")).not.toBeNull(), {
      timeout: 2_000,
    });
    const groups = [...(dialog()?.querySelectorAll("[data-group]") ?? [])];
    expect(groups.map((group) => group.getAttribute("data-group"))).toEqual(["api"]);
    expect(groups[0]?.querySelector("h3")?.textContent).toBe("api");
    expect([...(groups[0]?.querySelectorAll("a") ?? [])].map((row) => row.getAttribute("href"))).toEqual([
      "/s/two",
      "/s/one",
    ]);
    await page.unmount();
  });

  it("labels a row with its name, else the start of its first message, else its folder, never its id", async () => {
    const page = await withMenu("/");
    await settle();
    await feed([
      shellSession({ id: "one", cwd: "/w/api", name: "Fix login", updatedAt: 1 }),
      shellSession({ id: "two", cwd: "/w/api", preview: "fix the flaky test", updatedAt: 2 }),
      shellSession({ id: "three", cwd: "/w/api", updatedAt: 3 }),
    ]);
    await ctrlB();
    await opened("Sessions");
    await vi.waitFor(() => expect(dialog()?.querySelectorAll("a")).toHaveLength(3), { timeout: 2_000 });
    expect(
      [...(dialog()?.querySelectorAll("[data-session-label]") ?? [])].map((row) => row.textContent),
    ).toEqual(["api", "fix the flaky test", "Fix login"]);
    await page.unmount();
  });

  it("opening a row navigates to the session and closes the drawer", async () => {
    const page = await withMenu("/");
    await settle();
    await feed([session("one", "/w/api", 1), session("two", "/w/api", 2)]);
    await ctrlB();
    await opened("Sessions");
    await click(dialog()?.querySelector('a[href="/s/one"]') as HTMLElement);
    await settle();
    expect(page.router.state.location.pathname).toBe("/s/one");
    await vi.waitFor(() => expect(dialog()).toBeNull(), { timeout: 2_000 });
    await page.unmount();
  });

  it("filters by folder and says so when nothing matches", async () => {
    const page = await withMenu("/");
    await settle();
    await feed([session("one", "/w/api", 1)]);
    await ctrlB();
    await opened("Sessions");
    const filter = dialog()?.querySelector("input") as HTMLInputElement;
    await typeInto(filter, "zzz");
    expect(dialog()?.textContent).toContain("No session matches.");
    expect(dialog()?.querySelectorAll("a")).toHaveLength(0);
    await page.unmount();
  });

  it.each([
    ["refused", "failed"],
    ["unreadable", "unreadable"],
  ])("a %s shell stream shows a banner with Retry, which asks the stream again", async (kind) => {
    let answers = 0;
    bed.handlers["subscribe.shell"] = () => {
      if (kind === "refused" && ++answers === 1) throw new RpcError("capacity");
      return { sub: `again-${++answers}` };
    };
    const page = await withMenu("/");
    await settle();
    if (kind === "unreadable") await act(async () => useShellStore.getState().apply({ kind: "snapshot" }));
    await ctrlB();
    await opened("Sessions");
    await vi.waitFor(() => expect(dialog()?.querySelector('[data-slot="banner"]')).not.toBeNull(), {
      timeout: 2_000,
    });
    expect(dialog()?.textContent).toContain(
      kind === "refused"
        ? "The session list could not be loaded."
        : "The session list could not be read. Reload the page.",
    );
    const retry = [...(dialog()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Retry");
    await click(retry as HTMLElement);
    await settle();
    expect(bed.called("subscribe.shell")).toHaveLength(2);
    expect(bed.called("sessions.list")).toEqual([]);
    await page.unmount();
  });

  it.each([
    ["tree", "Sessions", () => ctrlB()],
    [
      "inbox",
      "Inbox",
      (page: { container: HTMLElement }) =>
        click(page.container.querySelector('[aria-label="Inbox"]') as HTMLElement),
    ],
  ])("Escape in the %s drawer closes it and does not stop the run", async (_name, title, open) => {
    const stop = vi.fn();
    const off = registerCommand("session.stop", stop);
    const page = await withMenu("/s/one");
    await settle();
    const pane = page.container.querySelector<HTMLElement>('[data-pane-kind="session"] [data-stub]');
    await open(page);
    await opened(title);
    // The drawer traps focus, so the page can never report focus in the pane while it is open. Report it anyway
    // (the state the guards exist for): only the open dialog now keeps Escape from stopping the run.
    Object.defineProperty(document, "activeElement", { configurable: true, get: () => pane });
    try {
      await press(pane as HTMLElement, { key: "Escape", code: "Escape" });
    } finally {
      Reflect.deleteProperty(document, "activeElement");
    }
    await vi.waitFor(() => expect(dialog()).toBeNull(), { timeout: 2_000 });
    expect(stop).not.toHaveBeenCalled();
    off();
    await page.unmount();
  });
});

describe("tree drawer, first load", () => {
  it("shows nothing at first, then a labelled spinner while the snapshot is slow, then the rows", async () => {
    const page = await withMenu("/");
    await settle();
    // The spinner is a timer of the page (DESIGN.md §7.3: nothing for 200 ms), so the test owns that clock: a real
    // wait raced the load of the machine. Only the timers and performance.now are faked, from before the drawer mounts.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      await ctrlB();
      expect(dialog()?.querySelector("h2")?.textContent).toBe("Sessions");
      const spinner = () =>
        dialog()?.querySelector('[role="status"][aria-label]')?.getAttribute("aria-label");
      expect(spinner()).toBeUndefined();
      await act(async () => vi.advanceTimersByTimeAsync(199));
      expect(spinner()).toBeUndefined();
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(spinner()).toBe("Loading sessions");
    } finally {
      vi.useRealTimers();
    }
    await feed([session("one", "/w/api", 1)]);
    await settle();
    expect(dialog()?.querySelector('[data-slot="spinner"]')).toBeNull();
    expect(dialog()?.querySelectorAll("a")).toHaveLength(1);
    await page.unmount();
  });
});

describe("inbox drawer", () => {
  it("opens from its button with the empty state", async () => {
    const page = await withMenu("/");
    await settle();
    expect(dialog()).toBeNull();
    await click(page.container.querySelector('[aria-label="Inbox"]') as HTMLElement);
    await opened("Inbox");
    expect(dialog()?.getAttribute("data-variant")).toBe("drawer-right");
    expect(dialog()?.querySelector('[data-slot="empty-state"] h2')?.textContent).toBe(
      "Nothing waits for you",
    );
    expect(dialog()?.textContent).toContain(
      "Questions and finished tasks of your triggers appear here, those that need you first.",
    );
    await page.unmount();
  });

  it("opens an agent row's tab at its entry, and closes", async () => {
    const page = await withMenu("/");
    await settle();
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
    await act(async () =>
      bed.emitTo("subscribe.inbox", {
        kind: "snapshot",
        items: [
          {
            id: "i1",
            kind: "agent_reply",
            toHandle: false,
            taskId: null,
            sessionId: null,
            triggerName: "Atlas",
            costUsd: null,
            createdAt: Date.now(),
            readAt: Date.now(),
            resolvedAt: null,
            resolution: null,
            agentId: "atlas-1a2b",
            refId: null,
            entryId: "e7",
            detail: "Done",
          },
        ],
        unread: 0,
        toHandle: 0,
        truncated: false,
      }),
    );
    await click(page.container.querySelector('[aria-label="Inbox"]') as HTMLElement);
    await opened("Inbox");
    await click(dialog()?.querySelector('[data-slot="inbox-row"]') as HTMLElement);
    expect(
      useWorkspaceStore.getState().ws.tabs.some((tab) => JSON.stringify(tab).includes("atlas-1a2b")),
    ).toBe(true);
    expect(useFocusEntry.getState().target).toEqual({ sessionId: "s1", entryId: "e7" });
    await vi.waitFor(() => expect(dialog()).toBeNull());
    await page.unmount();
  });
  it("a memory review row ends on Settings › Memory, also when the page reloads right after (J09 flake)", async () => {
    const page = await withMenu("/");
    await settle();
    await act(async () =>
      bed.emitTo("subscribe.inbox", {
        kind: "snapshot",
        items: [
          itemOf({
            id: "m1",
            kind: "memory_review",
            agentId: "atlas-1a2b",
            refId: "f1",
            taskId: null,
            sessionId: null,
          }),
        ],
        unread: 1,
        toHandle: 1,
        truncated: false,
      }),
    );
    await click(page.container.querySelector('[aria-label^="Inbox"]') as HTMLElement);
    await opened("Inbox");
    await vi.waitFor(() => expect(dialog()?.querySelector('[data-slot="inbox-row"]')).not.toBeNull());
    await click(dialog()?.querySelector('[data-slot="inbox-row"]') as HTMLElement);
    await vi.waitFor(() => expect(dialog()).toBeNull());
    // The URL names the active item: a reload (the stale-chunk guard) mounts the shell again on this path.
    await vi.waitFor(() => expect(page.router.state.location.pathname).toBe("/settings/memory"));
    const landed = page.router.state.location.pathname;
    await page.unmount();
    const reloaded = await withMenu(landed);
    await settle();
    expect(activeTab(useWorkspaceStore.getState().ws)?.item).toEqual({ kind: "settings", section: "memory" });
    await reloaded.unmount();
  });
});
