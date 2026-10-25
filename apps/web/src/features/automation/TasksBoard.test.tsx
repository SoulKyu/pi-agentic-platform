// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_SHELL } from "../../stores/shell-reducer.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { button, click, settle, text, useLoadingClock, pastLoadingDelay } from "../../testing/dom.ts";
import {
  countsOf,
  current,
  failureOf,
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
const knowProjects = (...list: Array<ReturnType<typeof projectOf>>) =>
  useShellStore.setState({
    view: { ...EMPTY_SHELL, loaded: true, projects: new Map(list.map((p) => [p.id, p])) },
  });

// local noon: "today" is the local day, so the fixture must sit inside it in every time zone
const LOCAL_NOON = new Date(2026, 9, 15, 12, 0, 0).getTime();

const handlers = () => ({ onOpenSession: vi.fn(), onOpenTrigger: vi.fn(), onNewTrigger: vi.fn() });

beforeEach(() => {
  vi.useFakeTimers({ now: LOCAL_NOON, toFake: ["Date"] });
  useTasksStore.getState().reset();
  useShellStore.getState().reset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function phone(on: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: on && query === "(max-width: 767.98px)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

describe("TasksBoard", () => {
  it("waits for the first snapshot", async () => {
    useLoadingClock();
    newBed();
    const page = await showWithStepUp(<TasksBoard {...handlers()} />);
    await pastLoadingDelay();
    expect(page.container.querySelector('[role="status"]')?.textContent).toContain("Loading the tasks…");
  });

  it("shows the empty state with the purpose and a New trigger action for the only project", async () => {
    newBed();
    knowProjects(projectOf("p1", "atlas"));
    snapshot();
    const on = handlers();
    const page = await showWithStepUp(<TasksBoard {...on} />);
    expect(text(page.container)).toContain("Triggers run tasks for you on a schedule, a webhook or a feed.");
    expect(page.container.querySelector('[data-slot="empty-state"]')).not.toBeNull();
    await click(button(page.container, "New trigger"));
    expect(on.onNewTrigger).toHaveBeenCalledWith("p1");
  });

  it("asks for a folder first when no project is known", async () => {
    newBed();
    snapshot();
    const page = await showWithStepUp(<TasksBoard {...handlers()} />);
    expect(text(page.container)).toContain("Start a session in a folder first");
    expect(page.container.querySelectorAll("button")).toHaveLength(1); // only the pause switch
  });

  it("makes a column per project with its triggers strip and its cards", async () => {
    const bed = newBed();
    knowProjects(projectOf("p1", "atlas", 1), projectOf("p2", "scout", 2));
    snapshot({
      triggers: [
        triggerOf(),
        triggerOf({ id: "g2", name: "weekly", sourceType: "schedule", projectId: "p2", enabled: false }),
      ],
      tasks: [
        taskOf({ createdAt: LOCAL_NOON - 120_000, startedAt: LOCAL_NOON - 120_000 }),
        taskOf({
          id: "t2",
          projectId: "p2",
          state: "queued",
          startedAt: null,
          triggerName: "Weekly curation",
        }),
      ],
      failures: [failureOf()],
    });
    const on = handlers();
    const page = await showWithStepUp(<TasksBoard {...on} />);
    const columns = [...page.container.querySelectorAll<HTMLElement>('[data-slot="project-column"]')];
    expect(columns.map((column) => column.dataset.column)).toEqual(["p1", "p2"]);
    expect(text(columns[0] as HTMLElement)).toContain("atlas");
    expect(text(columns[0] as HTMLElement)).toContain("1 running");
    expect(text(columns[0] as HTMLElement)).toContain("$0.21 today");
    expect(text(columns[0] as HTMLElement)).toContain("Investigate HighMemory");
    expect(text(columns[1] as HTMLElement)).toContain("Weekly curation");
    expect(text(page.container)).toContain("1 background job failed");
    expect(page.container.querySelector('[data-slot="empty-state"]')).toBeNull();

    // the strip: Edit opens the trigger tab, New trigger starts one for the column's project, the Switch writes.
    await click(button(columns[0] as HTMLElement, "Edit prod-alerts"));
    expect(on.onOpenTrigger).toHaveBeenCalledWith("g1");
    await click(button(columns[1] as HTMLElement, "New trigger"));
    expect(on.onNewTrigger).toHaveBeenCalledWith("p2");
    const toggle = (columns[1] as HTMLElement).querySelector(
      '[data-slot="trigger-strip"] [role="switch"]',
    ) as HTMLElement;
    await click(toggle);
    await settle();
    expect(bed.called("automation.triggers.setEnabled")[0]?.params).toEqual({
      triggerId: "g2",
      enabled: true,
    });
  });

  it("opens the session of a card through the pane and marks that card as current", async () => {
    newBed();
    knowProjects(projectOf("p1", "atlas"));
    snapshot({ triggers: [triggerOf()], tasks: [taskOf()] });
    const on = handlers();
    const page = await showWithStepUp(<TasksBoard {...on} />);
    await click(button(page.container, "Steer"));
    expect(on.onOpenSession).toHaveBeenCalledWith("s1");
    expect(page.container.querySelector('[data-slot="task-card"]')?.getAttribute("aria-current")).toBe(
      "true",
    );
  });

  it("moves a limited task out of limited when the stream says it is cancelled", async () => {
    newBed();
    knowProjects(projectOf("p1", "atlas"));
    snapshot({ triggers: [triggerOf()], tasks: [taskOf({ state: "limited" })] });
    const page = await showWithStepUp(<TasksBoard {...handlers()} />);
    await click(button(page.container, "Cancel task"));
    await settle();
    await act(async () => {
      useTasksStore
        .getState()
        .apply({ kind: "task", task: taskOf({ state: "cancelled", endedAt: 5 }), previous: "limited" });
    });
    const card = page.container.querySelector('[data-slot="task-card"]') as HTMLElement;
    expect(card.dataset.state).toBe("cancelled");
    expect(text(card)).toContain("Cancelled");
    expect(text(card)).not.toContain("Resume now");
  });

  it("puts tasks of no known project in 'Other folders', last", async () => {
    newBed();
    knowProjects(projectOf("p1", "atlas"));
    snapshot({ triggers: [triggerOf()], tasks: [taskOf({ id: "x", projectId: null })] });
    const page = await showWithStepUp(<TasksBoard {...handlers()} />);
    const columns = [...page.container.querySelectorAll<HTMLElement>('[data-slot="project-column"]')];
    expect(columns.map((column) => column.dataset.column)).toEqual(["p1", "other"]);
    expect(text(columns[1] as HTMLElement)).toContain("Other folders");
  });

  it("stacks the columns on a phone", async () => {
    phone(true);
    newBed();
    knowProjects(projectOf("p1", "atlas"));
    snapshot({ triggers: [triggerOf()] });
    const page = await showWithStepUp(<TasksBoard {...handlers()} />);
    const layout = page.container.querySelector('[data-slot="board-columns"]') as HTMLElement;
    expect(layout.dataset.layout).toBe("stack");
    expect(layout.className).toContain("flex-col");
  });

  it("lays the columns side by side on a wide pane", async () => {
    phone(false);
    newBed();
    knowProjects(projectOf("p1", "atlas"));
    snapshot({ triggers: [triggerOf()] });
    const page = await showWithStepUp(<TasksBoard {...handlers()} />);
    const layout = page.container.querySelector('[data-slot="board-columns"]') as HTMLElement;
    expect(layout.dataset.layout).toBe("grid");
    expect(layout.className).not.toContain("flex-col");
  });
});
