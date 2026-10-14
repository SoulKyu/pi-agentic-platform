// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance, useAppearanceStore } from "../../features/appearance/index.ts";
import { runCommand, startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore, type Tab } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { press, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTerminalStore } from "../../stores/terminal-store.ts";
import { terminalView } from "../../testing/m8-fixtures.ts";
import { shellProject, shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
const auth = vi.hoisted(() => ({ logout: vi.fn() }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../../features/auth/auth-api.ts", async (original) => ({
  ...(await original<typeof import("../../features/auth/auth-api.ts")>()),
  logout: auth.logout,
}));
vi.mock("../../features/sessions/SessionListScreen.tsx", async () => {
  const { createElement } = await import("react");
  return { SessionListScreen: () => createElement("p", { "data-stub": "home" }) };
});
vi.mock("../../features/sessions/SessionScreen.tsx", async () => {
  const { createElement } = await import("react");
  return { SessionScreen: () => createElement("p", { "data-stub": "session" }) };
});

const tab = (id: string): Tab => ({ key: `session:${id}`, item: { kind: "session", id }, split: null });
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const run = async (id: string): Promise<boolean> => {
  let claimed = false;
  await act(async () => {
    claimed = runCommand(id);
  });
  await settle();
  return claimed;
};

let started: Array<{ stop(): void }> = [];
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
});
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  const bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useShellStore.getState().reset();
  useWorkspaceStore.setState({ ws: { tabs: [tab("a"), tab("b")], active: "session:b" } });
  auth.logout.mockReset().mockResolvedValue(undefined);
});

describe("the shell's commands", () => {
  it("tab.next and tab.prev move the active tab and the URL", async () => {
    const page = await renderShell("/s/b");
    expect(await run("tab.next")).toBe(true);
    expect(page.router.state.location.pathname).toBe("/s/a");
    expect(await run("tab.prev")).toBe(true);
    expect(page.router.state.location.pathname).toBe("/s/b");
    await page.unmount();
  });

  it("tab.close closes the active tab and goes to its neighbour", async () => {
    const page = await renderShell("/s/b");
    expect(await run("tab.close")).toBe(true);
    expect(useWorkspaceStore.getState().ws.tabs.map((one) => one.key)).toEqual(["session:a"]);
    expect(page.router.state.location.pathname).toBe("/s/a");
    await page.unmount();
  });

  it("tab and pane commands decline when no tab is open, so the key keeps its browser meaning", async () => {
    const page = await renderShell("/nope");
    useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
    expect([await run("tab.next"), await run("tab.prev"), await run("tab.close")]).toEqual([
      false,
      false,
      false,
    ]);
    expect(await run("pane.split")).toBe(false);
    await page.unmount();
  });

  it("pane.split splits on desktop and declines on a phone", async () => {
    const desktop = await renderShell("/s/b", { phone: false });
    expect(await run("pane.split")).toBe(true);
    expect(useWorkspaceStore.getState().ws.tabs.find((one) => one.key === "session:b")?.split?.item).toEqual({
      kind: "session",
      id: "a",
    });
    expect(await run("pane.close")).toBe(true);
    expect(useWorkspaceStore.getState().ws.tabs.find((one) => one.key === "session:b")?.split).toBeNull();
    expect(await run("pane.close")).toBe(false); // nothing to close
    await desktop.unmount();
    const phone = await renderShell("/s/b", { phone: true });
    expect(await run("pane.split")).toBe(false);
    expect(useWorkspaceStore.getState().ws.tabs.find((one) => one.key === "session:b")?.split).toBeNull();
    await phone.unmount();
  });

  it("session.new opens the start item", async () => {
    const page = await renderShell("/s/b");
    expect(await run("session.new")).toBe(true);
    expect(page.router.state.location.pathname).toBe("/");
    await page.unmount();
  });

  it("appearance.cycleMode goes system, night, day, system", async () => {
    const page = await renderShell("/s/b");
    const mode = () => useAppearanceStore.getState().account.mode;
    const account = useAppearanceStore.getState().account;
    act(() => useAppearanceStore.getState().setAccount({ ...account, mode: "system" }));
    const seen = [mode()];
    for (let step = 0; step < 3; step++) {
      expect(await run("appearance.cycleMode")).toBe(true);
      seen.push(mode());
    }
    expect(seen).toEqual(["system", "night", "day", "system"]);
    await page.unmount();
  });

  it("settings.open goes to the appearance section", async () => {
    const page = await renderShell("/s/b");
    expect(await run("settings.open")).toBe(true);
    expect(page.router.state.location.pathname).toBe("/settings/appearance");
    await page.unmount();
  });

  it("auth.signOut calls logout, then onSignedOut", async () => {
    const onSignedOut = vi.fn();
    const page = await renderShell("/s/b", { onSignedOut });
    expect(await run("auth.signOut")).toBe(true);
    expect(auth.logout).toHaveBeenCalledOnce();
    expect(onSignedOut).toHaveBeenCalledOnce();
    await page.unmount();
  });

  it("auth.signOut that fails tells the user and signs nobody out", async () => {
    auth.logout.mockRejectedValue(new Error("offline"));
    const onSignedOut = vi.fn();
    const page = await renderShell("/s/b", { onSignedOut });
    await run("auth.signOut");
    await vi.waitFor(() => expect(document.body.textContent).toContain("Sign-out did not reach pap."), {
      timeout: 2_000,
    });
    expect(onSignedOut).not.toHaveBeenCalled();
    await page.unmount();
  });

  it("shortcuts.help shows the help once its chunk has loaded", async () => {
    const page = await renderShell("/s/b");
    expect(dialog()).toBeNull();
    expect(await run("shortcuts.help")).toBe(true);
    await vi.waitFor(() => expect(dialog()?.querySelector("h2")?.textContent).toBe("Keyboard shortcuts"), {
      timeout: 2_000,
    });
    await page.unmount();
  });

  it("drawer.tree.toggle opens the drawer, and Ctrl+B closes it again (M3-RT-30)", async () => {
    const page = await renderShell("/s/b");
    expect(await run("drawer.tree.toggle")).toBe(true);
    await vi.waitFor(() => expect(dialog()?.querySelector("h2")?.textContent).toBe("Sessions"), {
      timeout: 2_000,
    });
    const event = await press(document.activeElement ?? document.body, {
      key: "b",
      code: "KeyB",
      ctrlKey: true,
    });
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(dialog()).toBeNull(), { timeout: 2_000 });
    await page.unmount();
  });

  it("drawer.inbox.toggle opens and closes the inbox", async () => {
    const page = await renderShell("/s/b");
    await run("drawer.inbox.toggle");
    await vi.waitFor(() => expect(dialog()?.querySelector("h2")?.textContent).toBe("Inbox"), {
      timeout: 2_000,
    });
    await run("drawer.inbox.toggle");
    await vi.waitFor(() => expect(dialog()).toBeNull(), { timeout: 2_000 });
    await page.unmount();
  });
});

describe("the session surface commands (M8R73)", () => {
  const ws = () => useWorkspaceStore.getState().ws;
  const withSession = () => {
    useShellStore.getState().apply(
      shellSnapshot([shellSession({ id: "b", cwd: "/w/api/src", projectId: "p" })], {
        projects: [shellProject({ id: "p", root: "/w/api" })],
      }),
    );
  };

  it("showChanges and showFiles split the active session tab with the project root", async () => {
    withSession();
    const page = await renderShell("/s/b");
    expect(await run("session.showChanges")).toBe(true);
    expect(ws().tabs[1]?.split?.item).toEqual({ kind: "changes", root: "/w/api" });
    expect(await run("session.showFiles")).toBe(true);
    expect(ws().tabs[1]?.split?.item).toEqual({ kind: "files", root: "/w/api" });
    expect(ws().tabs[0]?.split).toBeNull();
    await page.unmount();
  });

  it("openTerminal splits with this session's newest running terminal", async () => {
    withSession();
    useTerminalStore.getState().reset();
    const page = await renderShell("/s/b");
    useTerminalStore.getState().apply({
      kind: "snapshot",
      terminals: [terminalView(1, { sessionId: "b" }), terminalView(2, { sessionId: "b" })],
    });
    expect(await run("session.openTerminal")).toBe(true);
    await vi.waitFor(
      () => expect(ws().tabs[1]?.split?.item).toEqual({ kind: "terminal", id: terminalView(2).id }),
      {
        timeout: 2_000,
      },
    );
    await page.unmount();
  });

  it("openTerminal declines until the terminal stream has answered, and creates nothing", async () => {
    withSession();
    const page = await renderShell("/s/b");
    expect(await run("session.openTerminal")).toBe(false);
    expect(ws().tabs[1]?.split).toBeNull();
    await page.unmount();
  });

  it("decline on a tab that is not a session, with no tab, and for a session the store lacks", async () => {
    const page = await renderShell("/nope");
    useWorkspaceStore.setState({ ws: { tabs: [tab("b")], active: "session:b" } });
    for (const id of ["session.showChanges", "session.openTerminal", "session.showFiles"])
      expect(await run(id), `${id} without the session in the store`).toBe(false);
    withSession();
    useWorkspaceStore.setState({
      ws: { tabs: [{ key: "home", item: { kind: "home" }, split: null }], active: "home" },
    });
    for (const id of ["session.showChanges", "session.openTerminal", "session.showFiles"])
      expect(await run(id), `${id} on home`).toBe(false);
    useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
    for (const id of ["session.showChanges", "session.openTerminal", "session.showFiles"])
      expect(await run(id), `${id} with no tab`).toBe(false);
    await page.unmount();
  });
});
