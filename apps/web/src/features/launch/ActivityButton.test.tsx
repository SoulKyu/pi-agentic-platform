// @vitest-environment happy-dom
import type { TaskView } from "@pap/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLaunchStore } from "../../stores/launch-store.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { EMPTY_TASKS } from "../../stores/tasks-reducer.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { laneSnapshot, laneView } from "../../testing/lane-fixtures.ts";
import { boxProject } from "../../testing/box-fixtures.ts";
import { click, mount, settle } from "../../testing/dom.ts";
import { launchAt, PROJECT_BOX } from "../../testing/launch-bed.ts";
import { shellSnapshot } from "../../testing/shell-snapshot.ts";
import { ActivityButton } from "./ActivityButton.tsx";

vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { to: string; children: ReactNode; onClick?: () => void }) =>
      createElement("a", { href: props.to, onClick: props.onClick }, props.children),
    useNavigate: () => () => Promise.resolve(),
  };
});

const WHERE = {
  agentPath: (agent: { id: string }) => `/agents/${agent.id}`,
  lanePath: (id: string) => `/lane/${id}`,
};
const task = (patch: Partial<TaskView> = {}): TaskView => ({
  id: "t1",
  triggerId: null,
  triggerName: "nightly",
  projectId: PROJECT_BOX,
  state: "queued",
  reason: null,
  origin: "schedule",
  title: "Nightly check",
  detail: null,
  createdAt: 1,
  startedAt: null,
  endedAt: null,
  sessionId: null,
  needsInput: false,
  costUsd: 0,
  resetAt: null,
  toolsReleased: false,
  waiting: { reason: "image_build", position: 1 },
  ...patch,
});
const tasks = (...list: TaskView[]) =>
  act(async () => void useTasksStore.setState({ view: { ...EMPTY_TASKS, loaded: true, list } }));
const launching = () =>
  act(async () => {
    useLaunchStore.getState().apply({ kind: "launch", launch: launchAt("vm", Date.now() - 2000) });
  });
const indicator = (root: ParentNode) =>
  [...root.querySelectorAll("button")].find((b) => /in progress/.test(b.getAttribute("aria-label") ?? ""));
const labelOf = (root: ParentNode) => indicator(root)?.getAttribute("aria-label");

beforeEach(() => {
  useLaunchStore.getState().reset();
  useTasksStore.getState().reset();
  useLaneStore.getState().reset();
  useShellStore.getState().reset();
  useShellStore
    .getState()
    .apply(shellSnapshot([], { projects: [boxProject("starting", { id: PROJECT_BOX })] }));
});

describe("ActivityButton", () => {
  it("counts live launches, and hides at zero", async () => {
    const page = await mount(<ActivityButton where={WHERE} />);
    await settle();
    expect(indicator(page.container)).toBeUndefined();
    await launching();
    await vi.waitFor(() => expect(labelOf(page.container)).toBe("1 in progress"));
    await act(async () => useLaunchStore.getState().apply({ kind: "end", id: "l1", done: true, ok: true }));
    await vi.waitFor(() => expect(indicator(page.container)).toBeUndefined());
  });

  it("a waiting task does not count in the indicator", async () => {
    await tasks(task());
    const page = await mount(<ActivityButton where={WHERE} />);
    await settle();
    expect(indicator(page.container)).toBeUndefined();
    await launching();
    await vi.waitFor(() => expect(labelOf(page.container)).toBe("1 in progress"));
  });

  it("a lane being set up counts in the indicator and links to its lane", async () => {
    await act(async () =>
      useLaneStore
        .getState()
        .apply(
          laneSnapshot([
            laneView({ id: "fix-1a2b", title: "Fix login", state: "creating" }),
            laneView({ id: "done-3c4d", state: "active" }),
          ]),
        ),
    );
    const page = await mount(<ActivityButton where={WHERE} />);
    await vi.waitFor(() => expect(labelOf(page.container)).toBe("1 in progress"));
    await click(indicator(page.container) as HTMLElement);
    await vi.waitFor(() => expect(document.querySelectorAll("[data-activity-row]").length).toBe(1));
    const row = document.querySelector("[data-activity-row]") as HTMLElement;
    expect(row.querySelector("a")?.getAttribute("href")).toBe("/lane/fix-1a2b");
    expect(row.textContent).toContain("Fix login");
  });

  it("each row links to its screen", async () => {
    await launching();
    const page = await mount(<ActivityButton where={WHERE} />);
    await vi.waitFor(() => expect(indicator(page.container)).toBeDefined());
    await click(indicator(page.container) as HTMLElement);
    await vi.waitFor(() => expect(document.querySelectorAll("[data-activity-row]").length).toBe(1));
    const rows = [...document.querySelectorAll("[data-activity-row]")];
    expect(rows.map((row) => row.querySelector("a")?.getAttribute("href"))).toEqual(["/"]);
    expect(rows[0]?.textContent).toContain("notes");
    expect(rows[0]?.textContent).toContain("VM start");
  });
});
