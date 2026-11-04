// @vitest-environment happy-dom
import type { AgentSummary } from "@pap/contracts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance, useAppearanceStore } from "../../features/appearance/index.ts";
import { DEFAULT_ACCOUNT } from "../../features/appearance/model.ts";
import { runCommand, startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import { ownerSnapshot } from "../../features/overview/overview-fixtures.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { click, hasButton, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("./HomePane.tsx", async () => {
  const { createElement } = await import("react");
  return { HomePane: () => createElement("p", { "data-stub": "home" }) };
});

const agent = (id: string, patch: Partial<AgentSummary> = {}): AgentSummary => ({
  id,
  name: id.split("-")[0]?.replace(/^./, (c) => c.toUpperCase()) ?? id,
  initials: id.slice(0, 2).toUpperCase(),
  state: "idle",
  unread: 0,
  paused: false,
  quarantined: false,
  unreadable: false,
  threadSessionId: null,
  lastActivityAt: 1,
  ...patch,
});

let started: Array<{ stop(): void }> = [];
let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  bed.handlers["overview.get"] = () => ownerSnapshot();
  current.runtime = bed.runtime;
  localStorage.clear();
  useShellStore.getState().reset();
  useAgentsStore.getState().reset();
  useAppearanceStore.setState({ account: DEFAULT_ACCOUNT });
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
});

const rail = () => document.querySelector<HTMLElement>('[data-slot="rail"]') as HTMLElement;
const pathname = (page: Awaited<ReturnType<typeof renderShell>>) => page.router.state.location.pathname;

describe("the Overview tab (decision 147)", () => {
  it("renders the pane at /overview and titles the tab", async () => {
    const page = await renderShell("/overview", { chunks: ["overview"] });
    await vi.waitFor(
      () =>
        expect(
          page.container.querySelector('[data-pane-kind="overview"] [data-overview-pane]'),
        ).not.toBeNull(),
      { timeout: 2_000 },
    );
    // The card actions join inside the lazy entry: a running box offers STOP.
    expect(hasButton(page.container, "Stop")).toBe(true);
    expect(useWorkspaceStore.getState().ws.tabs.map((tab) => tab.key)).toEqual(["overview"]);
    expect(page.container.querySelector('[role="tab"]')?.textContent).toContain("Overview");
    await page.unmount();
  });

  it("runs from the command and opens the tab", async () => {
    const page = await renderShell("/", { chunks: ["overview"] });
    await act(async () => {
      expect(runCommand("overview.open")).toBe(true);
    });
    await settle();
    expect(pathname(page)).toBe("/overview");
    await page.unmount();
  });

  it("runs from Ctrl+Alt+O", async () => {
    const page = await renderShell("/", { chunks: ["overview"] });
    const event = new KeyboardEvent("keydown", {
      key: "o",
      code: "KeyO",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "getModifierState", { value: () => false });
    await act(async () => {
      document.body.dispatchEvent(event);
    });
    await settle();
    expect(pathname(page)).toBe("/overview");
    await page.unmount();
  });
});

describe("the rail's Overview icon", () => {
  it("is the first button after the logo, before the agents, with no badge", async () => {
    const page = await renderShell("/");
    act(() => {
      useAgentsStore.getState().apply({
        kind: "snapshot",
        agents: [agent("atlas-1a2b", { unread: 3 })],
        requests: [],
        truncated: false,
      });
    });
    const buttons = [...rail().querySelectorAll("button")];
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Overview");
    expect(buttons[1]?.getAttribute("aria-label")).toContain("Atlas");
    expect(rail().firstElementChild?.tagName).toBe("A");
    expect(buttons[0]?.querySelector('[data-slot="badge"]')).toBeNull();
    await page.unmount();
  });

  it("has aria-current only while the Overview tab is active", async () => {
    const page = await renderShell("/", { chunks: ["overview"] });
    const icon = () => rail().querySelector<HTMLElement>('button[aria-label="Overview"]') as HTMLElement;
    expect(icon().getAttribute("aria-current")).toBeNull();
    await click(icon());
    await settle();
    expect(pathname(page)).toBe("/overview");
    expect(icon().getAttribute("aria-current")).toBe("page");
    await page.unmount();
  });
});

describe("Open on: Overview (R11)", () => {
  const openOn = (value: "home" | "overview") =>
    useAppearanceStore.setState({ account: { ...DEFAULT_ACCOUNT, openOn: value } });

  it("lands the first load at / on /overview, and a later logo click goes Home", async () => {
    openOn("overview");
    const page = await renderShell("/", { chunks: ["overview"] });
    await settle();
    expect(pathname(page)).toBe("/overview");
    const logo = page.container.querySelector('a[aria-label="pap"]') as HTMLElement;
    await click(logo);
    await settle();
    expect(pathname(page)).toBe("/");
    expect(page.container.querySelector('[data-stub="home"]')).not.toBeNull();
    await page.unmount();
  });

  it("does not redirect again once the Overview tab is closed: an empty workspace at / stays Home", async () => {
    openOn("overview");
    const page = await renderShell("/", { chunks: ["overview"] });
    await settle();
    expect(pathname(page)).toBe("/overview");
    await act(async () => {
      expect(runCommand("tab.close")).toBe(true);
    });
    await settle();
    expect(pathname(page)).toBe("/");
    expect(useWorkspaceStore.getState().ws.tabs.map((tab) => tab.key)).toEqual(["home"]);
    await page.unmount();
  });

  it("changes nothing with Home", async () => {
    openOn("home");
    const page = await renderShell("/", { chunks: ["overview"] });
    await settle();
    expect(pathname(page)).toBe("/");
    await page.unmount();
  });

  it("leaves a workspace that already holds a tab alone", async () => {
    openOn("overview");
    useWorkspaceStore.setState({
      ws: { tabs: [{ key: "tasks", item: { kind: "tasks" }, split: null }], active: "tasks" },
    });
    const page = await renderShell("/", { chunks: ["overview"] });
    await settle();
    expect(pathname(page)).toBe("/");
    await page.unmount();
  });

  it("does not take over a deep link", async () => {
    openOn("overview");
    const page = await renderShell("/tasks", { chunks: ["overview", "tasks"] });
    await settle();
    expect(pathname(page)).toBe("/tasks");
    await page.unmount();
  });
});
