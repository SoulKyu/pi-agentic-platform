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

describe("the phone's Agents tab (M11R109, board 12)", () => {
  it("offers to create the first agent when there is none", async () => {
    const page = await renderShell("/", { phone: true, chunks: ["newAgent"] });
    await load([]);
    await click(button(nav(page.container), "Agents"));
    await settle();
    expect(page.container.textContent).toContain("Create your first agent");
    await click(button(page.container, "New agent"));
    await vi.waitFor(
      () => expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe("New agent"),
      { timeout: 2_000 },
    );
    await page.unmount();
  });

  it("shows the microVM EmptyState when the VM stack is unusable", async () => {
    bed.handlers["agents.vmStatus"] = () => ({
      usable: false,
      reason: "no kvm",
      vmdVersion: null,
      claudeToken: "missing",
      agents: [],
    });
    const page = await renderShell("/", { phone: true, chunks: ["newAgent"] });
    await load([]);
    await click(button(nav(page.container), "Agents"));
    await settle();
    expect(page.container.textContent).toContain(
      "Agents run in microVMs: this machine needs KVM and `sudo pap vm setup`. See `pap doctor`.",
    );
    expect(page.container.textContent).not.toContain("Create your first agent");
    expect([...page.container.querySelectorAll("main button")].map((one) => one.textContent)).not.toContain(
      "New agent",
    );
    await page.unmount();
  });

  it("lists the agents with their state in words and opens one in the work section", async () => {
    const page = await renderShell("/", { phone: true });
    await load([summary("atlas-1a2b", { state: "needs_input", unread: 3 }), summary("bolt-0001")]);
    await click(agentsTab(page.container));
    const rows = [...page.container.querySelectorAll("main li button")].map((one) =>
      one.getAttribute("aria-label"),
    );
    expect(rows).toEqual(["Atlas, needs input, 3 unread", "Bolt"]);
    await click(button(page.container, "Bolt"));
    await settle();
    expect(page.router.state.location.pathname).toBe("/agents/bolt-0001");
    expect(button(nav(page.container), "Work").getAttribute("aria-current")).toBe("page");
    await page.unmount();
  });

  it("counts the unread activity on the tab, with the word and not only the number", async () => {
    const page = await renderShell("/", { phone: true });
    await load([summary("atlas-1a2b", { unread: 3 }), summary("bolt-0001", { unread: 2 })]);
    const badge = nav(page.container).querySelector('button [data-slot="badge"]');
    expect(badge?.textContent).toContain("5 unread");
    await page.unmount();
  });

  it("says in the list that a profile is unreadable, not only paused", async () => {
    const page = await renderShell("/", { phone: true });
    await load([summary("atlas-1a2b", { state: "paused", unreadable: true })]);
    await click(agentsTab(page.container));
    await settle();
    const row = page.container.querySelector("main li button");
    expect(row?.textContent).toContain("paused");
    expect(row?.textContent).toContain("profile unreadable");
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
