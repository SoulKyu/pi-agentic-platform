// @vitest-environment happy-dom
import { AgentInput, type AgentStatus, type AgentSummary, type AgentView } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { act } from "react";
import { alerts, button, click, hasButton, mount, settle, text } from "../../testing/dom.ts";
import { isDisabled, menuItem, menuLabels, openMenu, preloadMenu } from "../../testing/menu.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { AgentScreen, type ThreadSlot } from "./AgentScreen.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const ID = "atlas-1a2b";
const atlas: AgentSummary = {
  id: ID,
  name: "Atlas",
  initials: "AT",
  state: "idle",
  unread: 0,
  paused: false,
  quarantined: false,
  unreadable: false,
  threadSessionId: "s1",
  lastActivityAt: 1,
};
const view = (): AgentView => ({
  id: ID,
  name: "Atlas",
  input: AgentInput.parse({ name: "Atlas", role: "Tidy.", model: null }),
  state: "active",
  threadSessionId: "s1",
  unread: 0,
  paused: false,
  quarantinedAt: null,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
});
const status = (): AgentStatus =>
  ({
    today: { usd: 1.2, tokens: 12_400, budgetUsd: null, budgetTokens: null },
    days7Usd: 2.4,
    days30Usd: 9,
    billing: "api",
    tasks: [],
    triggers: [],
    truncated: false,
  }) as AgentStatus;

let bed: ReturnType<typeof fakeRuntime>;
let stepUp: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["agents.openThread"] = () => ({ sessionId: "s1" });
  bed.handlers["agents.get"] = () => view();
  bed.handlers["agents.events"] = () => ({ events: [], more: false, next: null });
  bed.handlers["agents.markRead"] = () => ({});
  bed.handlers["agents.prompts"] = () => ({ names: [] });
  bed.handlers["agents.status"] = () => status();
  bed.handlers["agents.permissions"] = () => ({
    tools: { preset: "default", active: "unknown-until-start" },
    sandbox: { required: true, effective: "on", network: true },
    hosts: "owner's list",
    blocked: 0,
    vaultNames: [],
    triggers: [],
    mcp: "owner's servers",
    trustedSources: [],
    trustedAutonomy: false,
    egress: "proxied",
    trifecta: { privateData: false, untrustedContent: false, exfiltration: false },
  });
  bed.handlers["secrets.list"] = () => ({ entries: [], state: "ok" });
  stepUp = vi.fn(async (run: (commandId: string) => Promise<unknown>) => run("step-cmd-0004"));
  useAgentsStore.getState().reset();
  useTasksStore.getState().reset();
  useSessionStore.setState({ views: {} });
  await preloadMenu();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const thread = (given: ThreadSlot) => (
  <div data-thread={given.sessionId}>
    {given.header}
    {given.beforeComposer}
  </div>
);
const widths = (wide: boolean, phone: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width: 1280") ? wide : query.includes("max-width: 767") ? phone : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
const show = async (summary: AgentSummary = atlas, statusPanel: "shown" | "hidden" = "hidden") => {
  act(() => {
    useAgentsStore.getState().apply({ kind: "snapshot", agents: [summary], requests: [], truncated: false });
  });
  const onOpenSettings = vi.fn();
  const page = await mount(
    <StepUpContext.Provider value={stepUp as unknown as StepUpRunner}>
      <AgentScreen
        agentId={ID}
        avatarStyle="outlined"
        eventCards="cards"
        statusPanel={statusPanel}
        thread={thread}
        presetField={() => <p>preset picker</p>}
        onOpenSettings={onOpenSettings}
        onOpenSession={() => {}}
        onOpenTrigger={() => {}}
      />
    </StepUpContext.Provider>,
  );
  await settle();
  return { page, onOpenSettings };
};
const body = () => document.body.textContent ?? "";

describe("the ⋯ menu leads to the real dialogs (Task 25 carry 1)", () => {
  it("has plain labels", async () => {
    const { page } = await show();
    await openMenu(button(page.container, "More actions"));
    expect(menuLabels()).toEqual(["Reset thread", "Settings", "Quarantine", "Delete"]);
  });

  it("opens the quarantine dialog from Quarantine", async () => {
    const { page, onOpenSettings } = await show();
    await openMenu(button(page.container, "More actions"));
    await click(menuItem("Quarantine"));
    await settle();
    expect(body()).toContain("Quarantine Atlas?");
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it("opens the delete dialog from Delete", async () => {
    const { page, onOpenSettings } = await show();
    await openMenu(button(page.container, "More actions"));
    await click(menuItem("Delete"));
    await settle();
    expect(body()).toContain("Delete Atlas?");
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it("does not offer a second quarantine to a quarantined agent", async () => {
    const { page } = await show({ ...atlas, state: "quarantined", quarantined: true, paused: true });
    await openMenu(button(page.container, "More actions"));
    expect(isDisabled(menuItem("Quarantine"))).toBe(true);
    expect(isDisabled(menuItem("Delete"))).toBe(false);
  });
});

describe("the agent's Settings tab (M11R126)", () => {
  it("opens from the Settings item and shows the form, the permissions sheet and the secrets list", async () => {
    const { page, onOpenSettings } = await show();
    await openMenu(button(page.container, "More actions"));
    await click(menuItem("Settings"));
    await settle();
    expect(page.container.querySelector("[data-agent-form]")).not.toBeNull();
    expect(page.container.querySelector("[data-thread]")).toBeNull();
    expect(text(page.container)).toContain("Permissions");
    expect(text(page.container)).toContain("Secrets");
    expect(text(page.container)).toContain("preset picker");
    expect(bed.called("agents.permissions")).toEqual([expect.objectContaining({ params: { agentId: ID } })]);
    expect(bed.called("secrets.list")).toEqual([expect.objectContaining({ params: { agentId: ID } })]);
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it("switches between Thread and Settings with the segmented control", async () => {
    const { page } = await show();
    await click(button(page.container, "Settings"));
    await settle();
    expect(page.container.querySelector("[data-agent-form]")).not.toBeNull();
    await click(button(page.container, "Thread"));
    await settle();
    expect(page.container.querySelector("[data-thread]")).not.toBeNull();
    expect(page.container.querySelector("[data-agent-form]")).toBeNull();
  });

  it("offers Reset thread, Quarantine and Delete at its end, each the same dialog as the menu", async () => {
    const { page } = await show();
    await click(button(page.container, "Settings"));
    await settle();
    expect(hasButton(page.container, "Quarantine…")).toBe(true);
    await click(button(page.container, "Quarantine…"));
    await settle();
    expect(body()).toContain("Quarantine Atlas?");
  });

  it("reads the permissions of the agent whose tab it is", async () => {
    const { page } = await show();
    await click(button(page.container, "Settings"));
    await settle();
    expect(text(page.container)).toContain("Hosts: the list you set for all agents");
  });
});

describe("'Set a budget' opens this agent's Settings at the budget (Task 25 carry 2)", () => {
  it("focuses the budget field of the agent's own tab, not the generic Settings", async () => {
    widths(true, false);
    const { page, onOpenSettings } = await show(atlas, "shown");
    await click(button(page.container, "Set a budget"));
    await settle();
    expect(onOpenSettings).not.toHaveBeenCalled();
    expect(page.container.querySelector("[data-agent-form]")).not.toBeNull();
    const budget = page.container.querySelector('[data-slot="agent-budget"]');
    expect(budget).not.toBeNull();
    expect(budget?.contains(document.activeElement)).toBe(true);
  });

  it("closes the phone's status sheet on the way", async () => {
    widths(false, true);
    const { page } = await show(atlas, "shown");
    await click(button(page.container, "Status panel"));
    await settle();
    await click(button(document.body, "Set a budget"));
    await settle();
    expect(document.querySelector('[data-status-panel="sheet"]')).toBeNull();
    expect(page.container.querySelector("[data-agent-form]")).not.toBeNull();
  });
});

describe("fix round 1 (I2): resuming is reachable and refused in pap's words", () => {
  const quarantined = { ...atlas, state: "quarantined" as const, quarantined: true, paused: true };

  it("offers Resume from quarantine in the Settings tab, through the step-up", async () => {
    bed.handlers["agents.setPaused"] = () => ({});
    const { page } = await show(quarantined);
    await click(button(page.container, "Settings"));
    await settle();
    await click(button(page.container, "Resume from quarantine"));
    await settle();
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(bed.called("agents.setPaused")).toEqual([
      expect.objectContaining({
        params: { agentId: ID, paused: false },
        options: expect.objectContaining({ commandId: "step-cmd-0004" }),
      }),
    ]);
  });

  it("keeps it off for an agent that is not quarantined", async () => {
    const { page } = await show();
    await click(button(page.container, "Settings"));
    await settle();
    expect(button(page.container, "Resume from quarantine").disabled).toBe(true);
  });

  it("tells a half-deleted agent in the Settings tab's words", async () => {
    bed.handlers["agents.setPaused"] = () => {
      throw new RpcError("conflict");
    };
    const { page } = await show(quarantined);
    await click(button(page.container, "Settings"));
    await settle();
    await click(button(page.container, "Resume from quarantine"));
    await settle();
    expect(alerts(page.container).join(" ")).toContain("deletion did not finish");
  });

  it.each([
    ["conflict", "deletion did not finish"],
    ["session_busy", "quarantine is still running"],
  ] as const)("tells %s in the header's Resume in pap's words", async (code, words) => {
    bed.handlers["agents.setPaused"] = () => {
      throw new RpcError(code);
    };
    const { page } = await show({ ...atlas, paused: true, state: "paused" });
    await click(button(page.container, "Resume"));
    await settle();
    expect(alerts(page.container).join(" ")).toContain(words);
  });
});
