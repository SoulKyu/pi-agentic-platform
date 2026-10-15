// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { useWorkspaceStore } from "../../features/workspace/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { button, click, settle } from "../../testing/dom.ts";
import { terminalView } from "../../testing/m8-fixtures.ts";
import { shellProject, shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";
import { useTerminalStore } from "../../stores/terminal-store.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { useShellStore } from "../../stores/shell-store.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../../features/workspace/use-element-width.ts", () => ({ useElementWidth: () => 1000 }));
vi.mock("../../features/sessions/SessionListScreen.tsx", async () => {
  const { createElement } = await import("react");
  return { SessionListScreen: () => createElement("p", { "data-stub": "home" }) };
});
vi.mock("../../features/sessions/SessionScreen.tsx", async () => {
  const { createElement } = await import("react");
  return { SessionScreen: () => createElement("p", { "data-stub": "session" }) };
});

/** The session surface bar splits in the Changes and the Terminal panes, and open a menu: their chunks load before the page mounts. */
const SPLIT_PANES = { chunks: ["changes", "terminal", "menu"] } as const;

/** The terminal feed starts when its lazy chunk has loaded: deliver once the sub is open. */
const emitTerminal = (bed: ReturnType<typeof fakeRuntime>, event: unknown) =>
  vi.waitFor(() => bed.emitTo("subscribe.terminal", event), { timeout: 2_000 });

let started: Array<{ stop(): void }> = [];
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
});
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  const bed = fakeRuntime("idle");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useShellStore.getState().reset();
  useWorkspaceStore.setState({
    ws: {
      tabs: [
        {
          key: "session:a",
          item: { kind: "session", id: "a" },
          split: { item: { kind: "home" }, ratio: 0.4 },
        },
        { key: "home", item: { kind: "home" }, split: null },
        { key: "settings", item: { kind: "settings", section: "appearance" }, split: null },
      ],
      active: "session:a",
    },
  });
});

describe("PaneHost with a split", () => {
  it("shows both items around a labelled separator, and no menu until asked", async () => {
    const page = await renderShell("/s/a", SPLIT_PANES);
    await vi.waitFor(
      () => expect(page.container.querySelector('#pane-main [data-stub="session"]')).not.toBeNull(),
      { timeout: 2_000 },
    ); // the session screen is a lazy chunk
    expect(page.container.querySelector('[data-pane-role="split"] [data-stub="home"]')).not.toBeNull();
    const separator = page.container.querySelector('[role="separator"]') as HTMLElement;
    expect([separator.getAttribute("aria-label"), separator.getAttribute("aria-valuenow")]).toEqual([
      "Resize panes",
      "40",
    ]);
    expect(page.container.ownerDocument.querySelector('[role="menu"]')).toBeNull();
    await page.unmount();
  });

  it("changes the second item from its menu, and closes the split", async () => {
    const page = await renderShell("/s/a", SPLIT_PANES);
    await click(
      page.container.querySelector(
        '[data-pane-role="split"] [aria-label="Show in this pane"]',
      ) as HTMLElement,
    );
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull(), { timeout: 2000 });
    expect([...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent)).toEqual([
      "New session",
      "Settings",
    ]);
    await click(document.querySelectorAll('[role="menuitem"]')[1] as HTMLElement);
    await settle();
    expect(useWorkspaceStore.getState().ws.tabs[0]?.split).toEqual({
      item: { kind: "settings", section: "appearance" },
      ratio: 0.4,
    });
    await click(
      page.container.querySelector('[data-pane-role="split"] [aria-label="Close split"]') as HTMLElement,
    );
    expect(useWorkspaceStore.getState().ws.tabs[0]?.split).toBeNull();
    await page.unmount();
  });
});

describe("the session surface bar (M8R72)", () => {
  let bed: ReturnType<typeof fakeRuntime>;
  const ROOT = "/w/api";
  const tabA = { key: "session:a", item: { kind: "session", id: "a" }, split: null } as const;
  const bar = (page: { container: HTMLElement }) =>
    page.container.querySelector<HTMLElement>('[data-slot="surface-bar"]') as HTMLElement;
  const split = () => useWorkspaceStore.getState().ws.tabs[0]?.split?.item;
  const splitPane = (page: { container: HTMLElement }) =>
    page.container.querySelector<HTMLElement>('[data-pane-role="split"]');

  beforeEach(() => {
    bed = fakeRuntime("open");
    bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
    current.runtime = bed.runtime;
    useTerminalStore.getState().reset();
    useShellStore.getState().apply(
      shellSnapshot([shellSession({ id: "a", cwd: "/w/api/src", projectId: "p" })], {
        projects: [shellProject({ id: "p", root: ROOT })],
      }),
    );
    useWorkspaceStore.setState({ ws: { tabs: [tabA], active: "session:a" } });
  });

  it("shows Changes, Terminal and Files on a session tab and nothing on a settings tab", async () => {
    const page = await renderShell("/s/a", SPLIT_PANES);
    expect([...bar(page).querySelectorAll("button")].map((one) => one.textContent)).toEqual([
      "Changes",
      "Terminal",
      "Files",
    ]);
    expect(bar(page).getAttribute("aria-label")).toBe("Views of this session");
    await page.unmount();
    const settings = await renderShell("/settings/appearance");
    expect(settings.container.querySelector('[data-slot="surface-bar"]')).toBeNull();
    await settings.unmount();
  });

  it("Changes splits the tab with the changes of the project root, and the pane is the lazy one", async () => {
    const page = await renderShell("/s/a", SPLIT_PANES);
    expect(button(bar(page), "Changes").hasAttribute("aria-current")).toBe(false);
    await click(button(bar(page), "Changes"));
    expect(split()).toEqual({ kind: "changes", root: ROOT });
    await vi.waitFor(() => expect(splitPane(page)?.querySelector("[data-changes-pane]")).not.toBeNull(), {
      timeout: 2_000,
    });
    expect(button(bar(page), "Changes").getAttribute("aria-current")).toBe("true");
    expect(button(bar(page), "Files").hasAttribute("aria-current")).toBe(false);
    await click(button(bar(page), "Files"));
    expect(split()).toEqual({ kind: "files", root: ROOT });
    await page.unmount();
  });

  it("pressing the button of the item that is already the split focuses it, without a second split", async () => {
    const page = await renderShell("/s/a", SPLIT_PANES);
    await click(button(bar(page), "Changes"));
    const before = useWorkspaceStore.getState().ws;
    await click(button(bar(page), "Changes"));
    expect(useWorkspaceStore.getState().ws).toBe(before);
    expect(document.activeElement).toBe(splitPane(page));
    await page.unmount();
  });

  it("Terminal shows the newest running terminal tagged with the session and creates nothing", async () => {
    const page = await renderShell("/s/a", SPLIT_PANES);
    await settle();
    await emitTerminal(bed, {
      kind: "snapshot",
      terminals: [
        terminalView(1, { sessionId: "a" }),
        terminalView(3, { sessionId: "a", status: "exited" }),
        terminalView(2, { sessionId: "a" }),
        terminalView(4, { sessionId: "other" }),
      ],
    });
    await settle();
    await click(button(bar(page), "Terminal"));
    expect(split()).toEqual({ kind: "terminal", id: terminalView(2).id });
    expect(bed.called("terminal.create")).toHaveLength(0);
    await vi.waitFor(() => expect(splitPane(page)?.querySelector("[data-terminal-pane]")).not.toBeNull(), {
      timeout: 2_000,
    });
    await page.unmount();
  });

  it("Terminal with none creates one for the session and its folder, once per click run", async () => {
    const page = await renderShell("/s/a", SPLIT_PANES);
    await settle();
    await emitTerminal(bed, { kind: "snapshot", terminals: [] });
    await settle();
    bed.handlers["terminal.create"] = () => ({ terminalId: terminalView(7).id });
    const terminal = button(bar(page), "Terminal");
    await click(terminal);
    await click(terminal);
    await vi.waitFor(() => expect(split()).toEqual({ kind: "terminal", id: terminalView(7).id }), {
      timeout: 2_000,
    });
    const calls = bed.called("terminal.create");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual({
      requestId: expect.stringMatching(/^[A-Za-z0-9_-]{16,64}$/),
      cwd: "/w/api/src",
      sessionId: "a",
      cols: 80,
      rows: 24,
    });
    await page.unmount();
  });

  it("keeps Terminal disabled and busy until the stream's first snapshot, and creates nothing early (MC32)", async () => {
    const page = await renderShell("/s/a", SPLIT_PANES);
    await settle();
    bed.handlers["terminal.create"] = () => ({ terminalId: terminalView(6).id });
    const terminal = button(bar(page), "Terminal");
    expect([terminal.disabled, terminal.getAttribute("aria-busy")]).toEqual([true, "true"]);
    await click(terminal);
    expect(bed.called("terminal.create")).toHaveLength(0);
    expect(split()).toBeUndefined();
    await emitTerminal(bed, { kind: "snapshot", terminals: [] });
    await vi.waitFor(() => expect(button(bar(page), "Terminal").disabled).toBe(false), { timeout: 2_000 });
    expect(button(bar(page), "Terminal").hasAttribute("aria-busy")).toBe(false);
    await page.unmount();
  });

  it("does not forget a fresh terminal when an unrelated terminal event arrives first (MC32)", async () => {
    const page = await renderShell("/s/a", SPLIT_PANES);
    await settle();
    await emitTerminal(bed, { kind: "snapshot", terminals: [] });
    await settle();
    bed.handlers["terminal.create"] = () => ({ terminalId: terminalView(8).id });
    await click(button(bar(page), "Terminal"));
    await vi.waitFor(() => expect(split()).toEqual({ kind: "terminal", id: terminalView(8).id }), {
      timeout: 2_000,
    });
    await act(async () => {
      useTerminalStore
        .getState()
        .apply({ kind: "terminal", terminal: terminalView(30, { sessionId: "other" }) });
      useWorkspaceStore.getState().unsplit("session:a");
    });
    await click(button(bar(page), "Terminal"));
    await vi.waitFor(() => expect(split()).toEqual({ kind: "terminal", id: terminalView(8).id }), {
      timeout: 2_000,
    });
    expect(bed.called("terminal.create")).toHaveLength(1);
    await page.unmount();
  });

  it("clicks while a create is still running share it", async () => {
    const page = await renderShell("/s/a", SPLIT_PANES);
    await settle();
    await emitTerminal(bed, { kind: "snapshot", terminals: [] });
    await settle();
    let release: (value: { terminalId: string }) => void = () => {};
    bed.handlers["terminal.create"] = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const terminal = button(bar(page), "Terminal");
    await click(terminal);
    await click(terminal);
    expect(bed.called("terminal.create")).toHaveLength(1);
    release({ terminalId: terminalView(8).id });
    await vi.waitFor(() => expect(split()).toEqual({ kind: "terminal", id: terminalView(8).id }), {
      timeout: 2_000,
    });
    expect(bed.called("terminal.create")).toHaveLength(1);
    await page.unmount();
  });

  it("a failed create says why and splits nothing; the next click uses a fresh request id", async () => {
    const page = await renderShell("/s/a", SPLIT_PANES);
    await settle();
    await emitTerminal(bed, { kind: "snapshot", terminals: [] });
    await settle();
    bed.handlers["terminal.create"] = () => {
      throw new RpcError("terminal_unavailable");
    };
    await click(button(bar(page), "Terminal"));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Terminals are not available"), {
      timeout: 2_000,
    });
    expect(split()).toBeUndefined();
    await click(button(bar(page), "Terminal"));
    await vi.waitFor(() => expect(bed.called("terminal.create")).toHaveLength(2), { timeout: 2_000 });
    const [first, second] = bed
      .called("terminal.create")
      .map((one) => (one.params as { requestId: string }).requestId);
    expect(first).not.toBe(second);
    await page.unmount();
  });

  it("retries a create whose outcome is unknown with the same request id (R105), a fresh one after success", async () => {
    const page = await renderShell("/s/a", SPLIT_PANES);
    await settle();
    await emitTerminal(bed, { kind: "snapshot", terminals: [] });
    await settle();
    let answer: () => unknown = () => {
      throw new RpcError("connection_lost");
    };
    bed.handlers["terminal.create"] = () => answer();
    await click(button(bar(page), "Terminal"));
    await vi.waitFor(() => expect(bed.called("terminal.create")).toHaveLength(1), { timeout: 2_000 });
    await settle();
    answer = () => ({ terminalId: terminalView(9).id });
    await click(button(bar(page), "Terminal"));
    await vi.waitFor(() => expect(split()).toEqual({ kind: "terminal", id: terminalView(9).id }), {
      timeout: 2_000,
    });
    const ids = bed.called("terminal.create").map((one) => (one.params as { requestId: string }).requestId);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
    await page.unmount();
  });

  it("disables the three buttons for a session the store does not hold", async () => {
    useShellStore.getState().reset();
    const page = await renderShell("/s/a", SPLIT_PANES);
    for (const name of ["Changes", "Terminal", "Files"])
      expect(button(bar(page), name).disabled, name).toBe(true);
    await page.unmount();
  });
});
