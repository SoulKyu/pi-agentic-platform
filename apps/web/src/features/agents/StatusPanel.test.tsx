// @vitest-environment happy-dom
import { AgentInput, type AgentStatus, type AgentSummary, type AgentView } from "@pap/contracts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { button, click, hasButton, mount, settle, text } from "../../testing/dom.ts";
import { preloadMenu } from "../../testing/menu.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { AgentScreen, type ThreadSlot } from "./AgentScreen.tsx";
import { StatusPanel } from "./StatusPanel.tsx";

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
const NOW = Date.UTC(2026, 9, 16, 12);
const status = (patch: Partial<AgentStatus> = {}): AgentStatus =>
  ({
    today: { usd: 1.2, tokens: 12_400, budgetUsd: null, budgetTokens: null },
    days7Usd: 2.4,
    days30Usd: 9,
    billing: "api",
    tasks: [
      {
        id: "t1",
        triggerId: null,
        triggerName: "",
        projectId: null,
        state: "done",
        reason: null,
        origin: "agent",
        title: "Tidy the repo",
        detail: null,
        createdAt: NOW - 600_000,
        startedAt: NOW - 500_000,
        endedAt: NOW - 300_000,
        sessionId: "s9",
        needsInput: false,
        costUsd: 0.1,
        resetAt: null,
        toolsReleased: false,
        agentId: ID,
      },
    ],
    triggers: [
      {
        id: "g1",
        name: "Nightly tidy",
        enabled: true,
        state: "ok",
        source: { type: "manual" },
        execution: null,
        prompt: null,
        projectId: null,
        cwd: "/x",
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        webhookUrl: null,
        secretRotatedAt: null,
        nextFireAt: null,
        lastFireAt: null,
        redacted: false,
      },
    ],
    truncated: false,
    ...patch,
  }) as AgentStatus;

let bed: ReturnType<typeof fakeRuntime>;
beforeEach(async () => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["agents.status"] = () => status();
  bed.handlers["agents.get"] = () => view();
  bed.handlers["agents.openThread"] = () => ({ sessionId: "s1" });
  bed.handlers["agents.events"] = () => ({ events: [], more: false, next: null });
  bed.handlers["agents.prompts"] = () => ({ names: [] });
  useAgentsStore.getState().reset();
  useTasksStore.getState().reset();
  useSessionStore.setState({ views: {} });
  await preloadMenu();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const handlers = () => ({
  onOpenSettings: vi.fn(),
  onOpenSession: vi.fn(),
  onOpenTrigger: vi.fn(),
  onNewTrigger: vi.fn(),
  onClose: vi.fn(),
});
const panel = (given = handlers()) =>
  mount(<StatusPanel agentId={ID} layout="side" closeLabel="Hide status" {...given} />);
const load = () =>
  act(() => {
    useAgentsStore.getState().apply({ kind: "snapshot", agents: [atlas], requests: [], truncated: false });
  });
const FAKE = {
  toFake: ["setTimeout" as const, "clearTimeout" as const, "setInterval" as const, "clearInterval" as const],
};
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const taskEvent = (agentId: string, state: "running" | "done") => ({
  kind: "task",
  previous: null,
  task: { ...(status().tasks[0] ?? {}), id: `x-${agentId}`, agentId, state },
});

describe("what the panel shows (M11R125)", () => {
  it("reads agents.status when it opens and shows the 7 d and 30 d cost", async () => {
    await load();
    const page = await panel();
    await settle();
    expect(bed.called("agents.status")).toEqual([expect.objectContaining({ params: { agentId: ID } })]);
    const words = text(page.container);
    expect(words).toContain("$2.40");
    expect(words).toContain("$9.00");
    expect(words).toContain("Tidy the repo");
    expect(words).toContain("Nightly tidy");
  });

  it("shows the agent's recent memory under its own heading, read from its scope (M11R152)", async () => {
    bed.handlers["memory.list"] = () => ({
      items: [{ id: "m1", text: "Prefers short answers", createdAt: null, source: "agent" }],
      journal: [],
    });
    const page = await panel();
    await settle();
    const block = page.container.querySelector('[data-slot="agent-memory-recent"]');
    expect(block?.textContent).toContain("Prefers short answers");
    expect(text(page.container)).toContain("Recent memory");
    expect(bed.called("memory.list")[0]?.params).toEqual({ scope: { kind: "agent", id: ID } });
  });

  it("says there is no budget and links to the agent's settings, with no bars (the default)", async () => {
    const given = handlers();
    const page = await panel(given);
    await settle();
    expect(text(page.container)).toContain("No budget");
    expect(page.container.querySelectorAll('[role="meter"]')).toHaveLength(0);
    await click(button(page.container, "Set a budget"));
    expect(given.onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("draws a tokens bar and a cost bar against the budgets, and says so when over", async () => {
    bed.handlers["agents.status"] = () =>
      status({ today: { usd: 6, tokens: 10_000, budgetUsd: 5, budgetTokens: 50_000 } });
    const page = await panel();
    await settle();
    const meters = [...page.container.querySelectorAll('[role="meter"]')];
    expect(meters.map((meter) => meter.getAttribute("aria-valuetext"))).toEqual([
      "10k / 50k",
      "$6.00 / $5.00",
    ]);
    expect(text(page.container)).toContain("Over budget");
    expect(hasButton(page.container, "Set a budget")).toBe(false);
  });

  it("labels a subscription's figures API-equivalent", async () => {
    bed.handlers["agents.status"] = () => status({ billing: "subscription" });
    const page = await panel();
    await settle();
    expect(text(page.container)).toContain("API-equivalent");
  });

  it("opens a task's session, edits a trigger and starts a new one for this agent", async () => {
    const given = handlers();
    const page = await panel(given);
    await settle();
    await click(button(page.container, "Open"));
    await click(button(page.container, "Edit"));
    await click(button(page.container, "New trigger"));
    await click(button(page.container, "Hide status"));
    expect(given.onOpenSession).toHaveBeenCalledWith("s9");
    expect(given.onOpenTrigger).toHaveBeenCalledWith("g1");
    expect(given.onNewTrigger).toHaveBeenCalledTimes(1);
    expect(given.onClose).toHaveBeenCalledTimes(1);
  });

  it("says when the status cannot be read and tries again on request", async () => {
    bed.handlers["agents.status"] = () => {
      throw new RpcError("internal");
    };
    const page = await panel();
    await settle();
    expect(page.container.querySelector('[role="alert"]')).not.toBeNull();
    bed.handlers["agents.status"] = () => status();
    await click(button(page.container, "Try again"));
    await settle();
    expect(text(page.container)).toContain("$9.00");
  });
});

describe("when it reads again (no polling, debounced 1 s)", () => {
  it("reads once after an agents stream event, a second later, and not before", async () => {
    vi.useFakeTimers(FAKE);
    await load();
    await panel();
    await advance(0);
    expect(bed.called("agents.status")).toHaveLength(1);
    act(() => {
      useAgentsStore.getState().apply({ kind: "event", agentId: ID, eventId: 7 });
    });
    await advance(999);
    expect(bed.called("agents.status")).toHaveLength(1);
    await advance(1);
    expect(bed.called("agents.status")).toHaveLength(2);
  });

  it("folds events that arrive within the second into one read", async () => {
    vi.useFakeTimers(FAKE);
    await load();
    await panel();
    await advance(0);
    for (const eventId of [1, 2, 3]) {
      act(() => {
        useAgentsStore.getState().apply({ kind: "event", agentId: ID, eventId });
      });
      await advance(400);
    }
    await advance(600);
    expect(bed.called("agents.status")).toHaveLength(2);
  });

  it("reads again after a tasks event of this agent, not of another", async () => {
    vi.useFakeTimers(FAKE);
    await load();
    await panel();
    await advance(0);
    act(() => {
      useTasksStore.getState().apply(taskEvent("other-9f9f", "running"));
    });
    await advance(5000);
    expect(bed.called("agents.status")).toHaveLength(1);
    act(() => {
      useTasksStore.getState().apply(taskEvent(ID, "running"));
    });
    await advance(1000);
    expect(bed.called("agents.status")).toHaveLength(2);
  });

  it("never polls", async () => {
    vi.useFakeTimers(FAKE);
    await load();
    await panel();
    await advance(10 * 60_000);
    expect(bed.called("agents.status")).toHaveLength(1);
  });

  it("opens the tasks stream while it is mounted, and keeps a pending read from outliving it", async () => {
    vi.useFakeTimers(FAKE);
    await load();
    const page = await panel();
    await advance(0);
    expect(bed.called("subscribe.tasks")).toHaveLength(1);
    act(() => {
      useAgentsStore.getState().apply({ kind: "event", agentId: ID, eventId: 7 });
    });
    await page.unmount();
    await advance(5000);
    expect(bed.called("agents.status")).toHaveLength(1);
  });
});

describe("the three layouts (DESIGN §8) and the setting", () => {
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
  const screen = async (statusPanel: "shown" | "hidden", given = handlers()) => {
    await load();
    const page = await mount(
      <AgentScreen
        agentId={ID}
        avatarStyle="outlined"
        eventCards="cards"
        statusPanel={statusPanel}
        thread={thread}
        onOpenSettings={given.onOpenSettings}
        onOpenSession={given.onOpenSession}
        onOpenTrigger={given.onOpenTrigger}
      />,
    );
    await settle();
    return { page, given };
  };
  const side = (container: HTMLElement) => container.querySelector('[data-status-panel="side"]');
  const threadOf = (container: HTMLElement) => container.querySelector("[data-thread]");

  it("is a column beside the thread at 1280 px and more", async () => {
    widths(true, false);
    const { page } = await screen("shown");
    expect(side(page.container)).not.toBeNull();
    expect(threadOf(page.container)).not.toBeNull();
    expect(bed.called("agents.status")).toHaveLength(1);
  });

  it("is hidden by the setting, the toggle stays, and the panel reads nothing", async () => {
    widths(true, false);
    const { page } = await screen("hidden");
    expect(side(page.container)).toBeNull();
    expect(bed.called("agents.status")).toEqual([]);
    await click(button(page.container, "Status panel"));
    await settle();
    expect(side(page.container)).not.toBeNull();
    await click(button(page.container, "Hide status"));
    expect(side(page.container)).toBeNull();
  });

  it("is a pane of its own between 768 and 1279 px, in place of the thread", async () => {
    widths(false, false);
    const { page } = await screen("shown");
    expect(page.container.querySelector('[data-status-panel="pane"]')).toBeNull();
    await click(button(page.container, "Status panel"));
    await settle();
    expect(page.container.querySelector('[data-status-panel="pane"]')).not.toBeNull();
    expect(threadOf(page.container)?.closest("[hidden]")).not.toBeNull();
    await click(button(page.container, "Back to thread"));
    expect(page.container.querySelector('[data-status-panel="pane"]')).toBeNull();
    expect(threadOf(page.container)?.closest("[hidden]")).toBeNull();
  });

  it("is a sheet on the phone, opened by the toggle", async () => {
    widths(false, true);
    const { page } = await screen("shown");
    expect(document.querySelector('[data-status-panel="sheet"]')).toBeNull();
    await click(button(page.container, "Status panel"));
    await settle();
    expect(document.querySelector('[data-status-panel="sheet"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="dialog"]')?.getAttribute("data-variant")).toBe("sheet");
  });

  it("opens a new trigger tab for this agent", async () => {
    widths(true, false);
    const { page, given } = await screen("shown");
    await click(button(page.container, "New trigger"));
    expect(given.onOpenTrigger).toHaveBeenCalledWith(`new:agent:${ID}`);
  });
});
