// @vitest-environment happy-dom
import type { ShellSession } from "@pap/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { click, mount, settle } from "../../testing/dom.ts";
import { laneSnapshot, laneView } from "../../testing/lane-fixtures.ts";
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
});

const load = (sessions: ShellSession[]) =>
  act(async () =>
    useShellStore
      .getState()
      .apply(shellSnapshot(sessions, { projects: [shellProject({ id: "a", name: "Alpha", sessions: 3 })] })),
  );

async function show() {
  const Tree = () => <ProjectTree onPick={() => {}} chord="Ctrl+K" />;
  const root = createRootRoute({ component: Tree });
  const index = createRoute({ getParentRoute: () => root, path: "/", component: () => null });
  const session = createRoute({ getParentRoute: () => root, path: "/s/$sessionId", component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([index, session]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const page = await mount(<RouterProvider router={router} />);
  await settle();
  return page.container;
}
const links = (box: HTMLElement) => [...box.querySelectorAll("a")].map((a) => a.getAttribute("href"));
const toggle = (box: HTMLElement) => box.querySelector<HTMLButtonElement>("button[data-subagents-toggle]");

describe("ProjectTree: subagents under their parent (M11R153)", () => {
  const family = () => [
    shellSession({ id: "p", projectId: "a", updatedAt: 9, name: "Parent" }),
    shellSession({ id: "c1", projectId: "a", updatedAt: 8, parentId: "p", name: "Child one" }),
    shellSession({ id: "c2", projectId: "a", updatedAt: 7, parentId: "p", name: "Child two" }),
  ];

  it("lists only the parent at first, with a collapsed count; the children are not rendered yet", async () => {
    await load(family());
    const box = await show();
    expect(links(box)).toEqual(["/s/p"]);
    expect(toggle(box)?.textContent).toBe("2 subagents");
    expect(toggle(box)?.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the children nested under the parent once opened, and hides them again", async () => {
    await load(family());
    const box = await show();
    await click(toggle(box) as HTMLElement);
    expect(toggle(box)?.getAttribute("aria-expanded")).toBe("true");
    expect(links(box)).toEqual(["/s/p", "/s/c1", "/s/c2"]);
    const nested = box.querySelector("li ul");
    expect([...(nested?.querySelectorAll("a") ?? [])].map((a) => a.getAttribute("href"))).toEqual([
      "/s/c1",
      "/s/c2",
    ]);
    await click(toggle(box) as HTMLElement);
    expect(links(box)).toEqual(["/s/p"]);
  });

  it("files the children of a pinned parent and of a settled one under them too", async () => {
    await load([
      shellSession({ id: "pin", projectId: "a", pinRank: 1, name: "Pinned" }),
      shellSession({ id: "k1", projectId: "a", parentId: "pin" }),
      shellSession({ id: "st", projectId: "a", settledAt: 5, updatedAt: 5, name: "Settled" }),
      shellSession({ id: "k2", projectId: "a", parentId: "st", updatedAt: 4 }),
    ]);
    const box = await show();
    expect(links(box)).toEqual(["/s/pin"]);
    expect(toggle(box)?.textContent).toBe("1 subagent");
    await click(box.querySelector("button[aria-expanded]:not([data-subagents-toggle])") as HTMLElement);
    expect(box.querySelectorAll("button[data-subagents-toggle]")).toHaveLength(2);
    await click(toggle(box) as HTMLElement);
    expect(links(box)).toEqual(["/s/pin", "/s/k1", "/s/st"]);
  });

  it("files the children of a lane's session under it, inside the lane", async () => {
    await act(async () => {
      useShellStore
        .getState()
        .apply(
          shellSnapshot(
            [
              shellSession({ id: "in", cwd: "/p/worktrees/fix-a-1a2b", projectId: "a", name: "In lane" }),
              shellSession({ id: "kid", cwd: "/p/worktrees/fix-a-1a2b", projectId: "a", parentId: "in" }),
            ],
            { projects: [shellProject({ id: "a", name: "Alpha", root: "/w/api", sessions: 2 })] },
          ),
        );
      useLaneStore
        .getState()
        .apply(
          laneSnapshot(
            [laneView({ id: "fix-a-1a2b", title: "Fix", branch: "pi/fix", projectRoot: "/w/api" })],
            [],
            0,
          ),
        );
    });
    const box = await show();
    await click(box.querySelector('button[aria-expanded="false"]') as HTMLElement);
    expect(links(box)).toEqual(["/lane/fix-a-1a2b", "/s/in"]);
    expect(toggle(box)?.textContent).toBe("1 subagent");
  });

  it("says one subagent in the singular and shows no toggle for a session without children", async () => {
    await load([
      shellSession({ id: "p", projectId: "a", updatedAt: 9 }),
      shellSession({ id: "c1", projectId: "a", parentId: "p" }),
      shellSession({ id: "solo", projectId: "a", updatedAt: 1 }),
    ]);
    const box = await show();
    expect(box.querySelectorAll("button[data-subagents-toggle]")).toHaveLength(1);
    expect(toggle(box)?.textContent).toBe("1 subagent");
  });
});
