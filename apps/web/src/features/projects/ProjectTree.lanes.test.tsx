// @vitest-environment happy-dom
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerCommand } from "../../lib/command-registry.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useCurrentProject } from "../../stores/current-project.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { click, mount, settle } from "../../testing/dom.ts";
import { laneSnapshot, laneView } from "../../testing/lane-fixtures.ts";
import { openMenu, projectTrigger, choose } from "../../testing/menus-kit.tsx";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellProject, shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";
import ProjectTree from "./ProjectTree.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

beforeEach(() => {
  current.runtime = fakeRuntime("open").runtime;
  useShellStore.getState().reset();
  useLaneStore.getState().reset();
  useCurrentProject.setState({ projectId: null, storageRefused: false });
});

const loadArchived = vi.fn(async () => ({
  default: ({ count }: { count: number }) => <p data-list>list of {count}</p>,
}));

async function show(path = "/") {
  const Tree = () => <ProjectTree onPick={() => {}} chord="Ctrl+K" loadArchivedLanes={loadArchived} />;
  const root = createRootRoute({ component: Tree });
  const routes = ["/", "/s/$sessionId", "/lane/$laneId"].map((p) =>
    createRoute({ getParentRoute: () => root, path: p, component: () => null }),
  );
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const page = await mount(<RouterProvider router={router} />);
  await settle();
  return page.container;
}

const load = (archived = 0) =>
  act(async () => {
    useShellStore
      .getState()
      .apply(
        shellSnapshot(
          [
            shellSession({ id: "in", cwd: "/p/worktrees/fix-a-1a2b", name: "In lane", projectId: "p1" }),
            shellSession({ id: "loose", cwd: "/w/api", name: "Loose one", projectId: "p1" }),
          ],
          { projects: [shellProject({ id: "p1", name: "api", root: "/w/api", sessions: 2 })] },
        ),
      );
    useLaneStore.getState().apply(
      laneSnapshot(
        [
          laneView({
            id: "fix-a-1a2b",
            title: "Fix the thing",
            branch: "pi/fix-a",
            projectRoot: "/w/api",
            facts: {
              dirty: 2,
              ahead: 3,
              behind: 0,
              unpushed: 0,
              additions: 1,
              deletions: 1,
              checkedAt: 1,
              error: null,
            },
            pr: {
              number: 12,
              url: "u",
              state: "open",
              draft: false,
              conflicts: null,
              checks: null,
              checkedAt: 1,
              error: null,
            },
          }),
        ],
        [],
        archived,
      ),
    );
  });

describe("the tree's lane level", () => {
  it("shows a lane under its project with status word, title, branch, +ahead, dirty dot, #PR", async () => {
    await load();
    const box = await show();
    const row = box.querySelector("[data-lane-title]")?.closest("li") as HTMLElement;
    expect(row.querySelector("[data-lane-title]")?.textContent).toBe("Fix the thing");
    expect(row.querySelector("[data-lane-status]")?.textContent).toBe("In review");
    expect(row.querySelector("[data-lane-branch]")?.textContent).toBe("pi/fix-a");
    const facts = row.textContent ?? "";
    expect(facts).toContain("+3");
    expect(facts).toContain("2");
    expect(facts).toContain("#12");
    expect(row.querySelector(".sr-only")?.textContent).toBeTruthy();
  });

  it("expands to the lane's sessions; they no longer appear loose under the project", async () => {
    await load();
    const box = await show();
    expect(box.textContent).toContain("Loose one");
    expect(box.textContent).not.toContain("In lane");
    const toggle = box.querySelector<HTMLButtonElement>('button[aria-expanded="false"]') as HTMLButtonElement;
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(box.textContent).toContain("In lane");
  });

  it("marks the open lane with aria-current", async () => {
    await load();
    const box = await show("/lane/fix-a-1a2b");
    const link = box.querySelector("[data-lane-title]")?.closest("a");
    expect(link?.getAttribute("aria-current")).toBe("page");
  });

  it("ends with Archived lanes (n) only when n > 0, and opens the list on demand", async () => {
    await load(3);
    const box = await show();
    const section = box.querySelector("[data-archived-lanes]") as HTMLElement;
    expect(section.textContent).toContain("Archived lanes (3)");
    expect(loadArchived).not.toHaveBeenCalled();
    await click(section.querySelector("button") as HTMLButtonElement);
    await vi.waitFor(() => expect(section.querySelector("[data-list]")?.textContent).toBe("list of 3"), {
      timeout: 2_000,
    });
  });

  it("has no Archived lanes entry when none is archived", async () => {
    await load(0);
    expect((await show()).querySelector("[data-archived-lanes]")).toBeNull();
  });

  it("the project menu hides New lane while no handler is registered", async () => {
    await load();
    const box = await show();
    await openMenu(projectTrigger(box, "api"));
    expect([...document.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent)).not.toContain(
      "New lane",
    );
  });

  it("the project menu offers New lane once a handler exists, and runs it for that project", async () => {
    await load();
    const handler = vi.fn();
    const off = registerCommand("lanes.new", handler);
    const box = await show();
    await openMenu(projectTrigger(box, "api"));
    await choose("New lane");
    expect(handler).toHaveBeenCalledOnce();
    expect(useCurrentProject.getState().projectId).toBe("p1");
    off();
  });
});

describe("a refused lane stream", () => {
  it("the tree shows the error with Retry, and the lane tab does too", async () => {
    await load();
    act(() => useLaneStore.getState().fail("capacity"));
    const box = await show();
    expect(box.textContent).toContain("The lanes could not be loaded.");
    const retry = [...box.querySelectorAll("button")].find((b) => b.textContent === "Retry") as HTMLElement;
    expect(retry).toBeDefined();
    act(() => useLaneStore.getState().apply(laneSnapshot([])));
    await settle();
    expect(box.textContent).not.toContain("The lanes could not be loaded.");
  });
});
