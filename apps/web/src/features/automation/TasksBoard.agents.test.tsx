// @vitest-environment happy-dom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "../../i18n/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { EMPTY_SHELL } from "../../stores/shell-reducer.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { button, click, text } from "../../testing/dom.ts";
import {
  agentOf,
  countsOf,
  current,
  newBed,
  projectOf,
  showWithStepUp,
  taskOf,
  triggerOf,
} from "./board-bed.tsx";
import { TasksBoard } from "./TasksBoard.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

// local noon: "today" is the local day, so the fixture must sit inside it in every time zone
const NOON = new Date().setHours(12, 0, 0, 0);
const ATLAS = agentOf("atlas-1a2b", "Atlas");
const BOLT = agentOf("bolt-0001", "Bolt");
const snapshot = (over: Record<string, unknown> = {}) =>
  useTasksStore.getState().apply({
    kind: "snapshot",
    ...countsOf(),
    tasks: [],
    truncated: false,
    triggers: [],
    failures: [],
    ...over,
  });
const handlers = () => ({
  onOpenSession: vi.fn(),
  onOpenTrigger: vi.fn(),
  onNewTrigger: vi.fn(),
  onOpenAgent: vi.fn(),
});

beforeEach(() => {
  useTasksStore.getState().reset();
  useAgentsStore.getState().reset();
  useShellStore.setState({
    view: { ...EMPTY_SHELL, loaded: true, projects: new Map([["p1", projectOf("p1", "atlas")]]) },
  });
  act(() => {
    useAgentsStore
      .getState()
      .apply({ kind: "snapshot", agents: [ATLAS, BOLT], requests: [], truncated: false });
  });
});

describe("TasksBoard: a column per agent", () => {
  it("shows an agent column beside the project columns, with its slots, cost and trigger strip", async () => {
    newBed();
    snapshot({
      triggers: [
        triggerOf({ id: "g1", name: "morning", agentId: ATLAS.id, projectId: null, sourceType: "manual" }),
      ],
      tasks: [
        taskOf({
          id: "a",
          agentId: ATLAS.id,
          target: "isolated",
          projectId: null,
          costUsd: 0.4,
          startedAt: NOON,
        }),
        taskOf({ id: "p", projectId: "p1" }),
      ],
    });
    const on = handlers();
    const page = await showWithStepUp(<TasksBoard {...on} />);
    const column = page.container.querySelector<HTMLElement>(
      '[data-slot="agent-column"][data-column="atlas-1a2b"]',
    );
    expect(column).not.toBeNull();
    expect(page.container.querySelectorAll('[data-slot="agent-column"]')).toHaveLength(2);
    expect(page.container.querySelectorAll('[data-slot="project-column"]')).toHaveLength(1);
    const words = text(column as HTMLElement);
    expect(words).toContain("Atlas");
    expect(words).toContain("1 running");
    expect(words).toContain("$0.40 today");
    expect(words).toContain("morning");
    expect(words).toContain("Isolated task");
    await click(button(column as HTMLElement, "New trigger"));
    expect(on.onNewTrigger).toHaveBeenCalledWith("agent:atlas-1a2b");
  });

  it("writes 'requested by' on a delegated task and opens that agent", async () => {
    newBed();
    snapshot({
      tasks: [
        taskOf({
          id: "d",
          origin: "delegate",
          agentId: BOLT.id,
          requestedBy: ATLAS.id,
          target: "thread",
          projectId: null,
        }),
      ],
    });
    const on = handlers();
    const page = await showWithStepUp(<TasksBoard {...on} />);
    expect(text(page.container)).toContain("In thread");
    await click(button(page.container, "requested by Atlas"));
    expect(on.onOpenAgent).toHaveBeenCalledWith(ATLAS.id);
  });

  it("gives each agent refusal its own words, in English and French", async () => {
    newBed();
    snapshot({
      tasks: [
        taskOf({
          id: "a",
          state: "failed",
          reason: "thread_unavailable",
          agentId: ATLAS.id,
          projectId: null,
        }),
        taskOf({
          id: "b",
          state: "failed",
          reason: "sandbox_unavailable",
          agentId: ATLAS.id,
          projectId: null,
        }),
        taskOf({ id: "c", state: "failed", reason: "quarantined", agentId: ATLAS.id, projectId: null }),
      ],
    });
    const page = await showWithStepUp(<TasksBoard {...handlers()} />);
    const words = text(page.container);
    expect(words).toContain("the agent's thread was not available");
    expect(words).toContain("no usable sandbox on this host");
    expect(words).toContain("agent quarantined");
    expect(words).not.toContain("thread_unavailable");
    expect(words).not.toContain("sandbox_unavailable");
  });

  it("has the French words too", () => {
    expect(translate("fr", "automation.reason.thread_unavailable")).toBe(
      "le thread de l'agent n'était pas disponible",
    );
    expect(translate("fr", "automation.reason.sandbox_unavailable")).toContain("bac à sable");
    expect(translate("fr", "automation.reason.quarantined")).toBe("agent en quarantaine");
  });
});
