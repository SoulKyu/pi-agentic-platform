// @vitest-environment happy-dom
import type { AgentSummary } from "@pap/contracts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { button, click, settle } from "../../testing/dom.ts";
import { ownerSnapshot } from "../../features/overview/overview-fixtures.ts";
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

const summary = (id: string, patch: Partial<AgentSummary> = {}): AgentSummary => ({
  id,
  name: id.split("-")[0]?.replace(/^./, (c) => c.toUpperCase()) ?? id,
  initials: "AT",
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
  bed.handlers["models.overview"] = () => ({ providers: [], truncated: false });
  current.runtime = bed.runtime;
  localStorage.clear();
  useAgentsStore.getState().reset();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
  vi.unstubAllGlobals();
});

const nav = (container: HTMLElement) => container.querySelector('[data-slot="bottom-nav"]') as HTMLElement;
// The Agents tab is the first one; its name includes the unread badge, so it is found by place.
const agentsTab = (container: HTMLElement) => nav(container).querySelector("button") as HTMLElement;
const load = (agents: readonly AgentSummary[]) =>
  act(() => {
    useAgentsStore.getState().apply({ kind: "snapshot", agents, requests: [], truncated: false });
  });

describe("the phone's Agents tab shows the Overview (decision 147, §3.7)", () => {
  it("renders the Overview pane in place of the agents list", async () => {
    bed.handlers["overview.get"] = () => ownerSnapshot();
    const page = await renderShell("/", { phone: true, chunks: ["overview"] });
    await load([summary("atlas-1a2b"), summary("bolt-0001")]);
    await click(agentsTab(page.container));
    await vi.waitFor(() => expect(page.container.querySelector("main [data-overview-pane]")).not.toBeNull(), {
      timeout: 2_000,
    });
    expect(page.container.querySelector("main li button")).toBeNull();
    expect(page.container.querySelector("main [data-box-card]")).not.toBeNull();
    await page.unmount();
  });

  it("keeps the tab, and offers New agent and New project from the pane's own + menu", async () => {
    bed.handlers["overview.get"] = () => ownerSnapshot({ boxes: [] });
    const page = await renderShell("/", { phone: true, chunks: ["overview"] });
    await load([]);
    await click(agentsTab(page.container));
    await vi.waitFor(() => expect(page.container.querySelector("main [data-overview-pane]")).not.toBeNull(), {
      timeout: 2_000,
    });
    await settle();
    expect(page.container.textContent).toContain("Here you will see every agent and every project");
    expect(button(page.container, "New project")).toBeTruthy();
    expect(button(page.container, "New agent")).toBeTruthy();
    expect(agentsTab(page.container).getAttribute("aria-current")).toBe("page");
    await page.unmount();
  });

  it("counts the unread activity on the tab, with the word and not only the number", async () => {
    const page = await renderShell("/", { phone: true });
    await load([summary("atlas-1a2b", { unread: 3 }), summary("bolt-0001", { unread: 2 })]);
    const badge = nav(page.container).querySelector('button [data-slot="badge"]');
    expect(badge?.textContent).toContain("5 unread");
    await page.unmount();
  });

  it("clamps the tab badge like the rail: 99+ and the same accessible text", async () => {
    const page = await renderShell("/", { phone: true });
    await load([summary("atlas-1a2b", { unread: 80 }), summary("bolt-0001", { unread: 70 })]);
    const badge = nav(page.container).querySelector('button [data-slot="badge"]');
    expect(badge?.textContent).toContain("99+ unread");
    expect(badge?.textContent).not.toContain("150");
    await page.unmount();
  });
});
