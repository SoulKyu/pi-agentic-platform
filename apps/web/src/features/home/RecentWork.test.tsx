// @vitest-environment happy-dom
import type { ShellSession } from "@pap/contracts";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { button, click, mount, settle, text } from "../../testing/dom.ts";
import { fakeHomeActions } from "../../testing/home-actions.ts";
import { tasksSnapshot, taskView } from "../../testing/home-fixtures.ts";
import { laneSnapshot, laneView } from "../../testing/lane-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellProject, shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";
import { RecentWork } from "./RecentWork.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const FANOUT = "0123456789abcdef";
const api = shellProject({ id: "p1", name: "api", root: "/w/api", sessions: 1 });
const web = shellProject({ id: "p2", name: "web", root: "/w/web", sessions: 1 });
let bed: ReturnType<typeof fakeRuntime>;
let actions: ReturnType<typeof fakeHomeActions>;
const listed = (...sessions: ShellSession[]) =>
  useShellStore.getState().apply(shellSnapshot(sessions, { projects: [api, web] }));
const links = () => [...document.querySelectorAll("[data-recent-row] a")];
const show = async (project: typeof api | null = api) => {
  const page = await mount(<RecentWork project={project} actions={actions} />);
  await settle();
  return page.container;
};

beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["lanes.listArchived"] = () => ({ lanes: [], hasMore: false });
  actions = fakeHomeActions();
  useShellStore.getState().reset();
  useLaneStore.getState().reset();
  useTasksStore.getState().reset();
});

describe("Recent work (§3.4)", () => {
  it("lists the project's work, the most recent first, each a link to its item with type, state and age", async () => {
    listed(
      shellSession({ id: "a", projectId: "p1", cwd: "/w/api", updatedAt: 10, name: "Old" }),
      shellSession({
        id: "b",
        projectId: "p1",
        cwd: "/w/api",
        updatedAt: 20,
        name: "New",
        status: "running",
      }),
      shellSession({ id: "c", projectId: "p2", cwd: "/w/web", updatedAt: 30, name: "Elsewhere" }),
    );
    await show();
    expect(links().map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["New", "/s/b"],
      ["Old", "/s/a"],
    ]);
    const first = document.querySelector("[data-recent-row]") as HTMLElement;
    expect(text(first)).toContain("Session");
    expect(text(first)).toContain("Working");
    await click(links()[0] as HTMLElement);
    expect(actions.open).toHaveBeenCalledExactlyOnceWith({ kind: "session", id: "b" });
    expect(bed.called("sessions.list")).toEqual([]);
  });

  it("leaves a modified or non-primary click to the browser, so a new tab works", async () => {
    listed(shellSession({ id: "a", projectId: "p1", cwd: "/w/api", name: "One" }));
    await show();
    const link = links()[0] as HTMLElement;
    for (const init of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
      await act(async () => {
        link.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(actions.open).not.toHaveBeenCalled();
    await click(link);
    expect(actions.open).toHaveBeenCalledOnce();
  });

  it("shows a name that looks like markup as text only", async () => {
    listed(shellSession({ id: "a", projectId: "p1", name: "<b>x</b>" }));
    const container = await show();
    expect(links().map((link) => link.textContent)).toEqual(["<b>x</b>"]);
    expect(container.querySelector("b")).toBeNull();
  });

  it("shows 20 rows, then 20 more with each Show more", async () => {
    listed(
      ...Array.from({ length: 45 }, (_, i) =>
        shellSession({ id: `s${i}`, projectId: "p1", cwd: "/w/api", updatedAt: i + 1 }),
      ),
    );
    const container = await show();
    expect(links()).toHaveLength(20);
    expect(links()[0]?.getAttribute("href")).toBe("/s/s44");
    await click(button(container, "Show more"));
    expect(links()).toHaveLength(40);
    await click(button(container, "Show more"));
    expect(links()).toHaveLength(45);
    expect(() => button(container, "Show more")).toThrow();
  });

  it("filters by Sessions, Lanes and Tasks, the selected one said", async () => {
    listed(shellSession({ id: "s1", projectId: "p1", cwd: "/w/api", updatedAt: 3 }));
    useLaneStore
      .getState()
      .apply(laneSnapshot([laneView({ id: "l-1a2b", projectRoot: "/w/api", createdAt: 2 })]));
    useTasksStore.getState().apply(tasksSnapshot([taskView({ id: "t1", createdAt: 1 })]));
    const container = await show();
    const kinds = () =>
      [...document.querySelectorAll("[data-recent-row]")].map((row) => row.getAttribute("data-recent-row"));
    expect(kinds()).toEqual(["session", "lane", "task"]);
    const radio = (name: string) =>
      [...container.querySelectorAll<HTMLElement>('[role="radio"]')].find(
        (node) => node.textContent === name,
      ) as HTMLElement;
    await click(radio("Lanes"));
    expect(kinds()).toEqual(["lane"]);
    expect(radio("Lanes").getAttribute("aria-checked")).toBe("true");
    await click(radio("Tasks"));
    expect(kinds()).toEqual(["task"]);
    await click(radio("Sessions"));
    expect(kinds()).toEqual(["session"]);
  });

  it("reopens a fan-out's compare tab, its lanes archived ones included (lanes.listArchived)", async () => {
    listed();
    bed.handlers["lanes.listArchived"] = () => ({
      lanes: [
        laneView({
          id: "b-1a2b",
          projectRoot: "/w/api",
          fanoutId: FANOUT,
          state: "archived",
          archivedAt: 9,
          title: "Try caches",
        }),
      ],
      hasMore: false,
    });
    await show();
    expect(bed.called("lanes.listArchived")).toHaveLength(1);
    const row = document.querySelector('[data-recent-row="fanout"]') as HTMLElement;
    expect(text(row)).toContain("Fan-out");
    expect(text(row)).toContain("Archived");
    expect(row.querySelector("a")?.getAttribute("href")).toBe(`/compare/${FANOUT}`);
    await click(row.querySelector("a") as HTMLElement);
    expect(actions.open).toHaveBeenCalledExactlyOnceWith({ kind: "compare", id: FANOUT });
  });

  it("carries each row's project under All projects", async () => {
    listed(
      shellSession({ id: "a", projectId: "p1", cwd: "/w/api/one", updatedAt: 2 }),
      shellSession({ id: "b", projectId: "p2", cwd: "/w/web/two", updatedAt: 1 }),
    );
    await show(null);
    const chips = (index: number) =>
      [
        ...(document.querySelectorAll("[data-recent-row]")[index]?.querySelectorAll('[data-slot="chip"]') ??
          []),
      ].map((chip) => chip.textContent);
    expect(chips(0)).toEqual(["Session", "api"]);
    expect(chips(1)).toEqual(["Session", "web"]);
  });

  it("shows loading until the shell stream has loaded, then says when there is nothing yet", async () => {
    await show();
    expect(text(document.body)).toContain("Loading");
    await act(async () => listed());
    expect(text(document.body)).toContain("Nothing yet. Launch something above.");
  });

  it("says the shell stream broke, with Retry", async () => {
    useShellStore.getState().fail("capacity");
    const container = await show();
    expect([...container.querySelectorAll('[data-slot="inline-error"][role="status"]')]).toHaveLength(1);
    expect(button(container, "Retry")).toBeDefined();
  });

  it("says archived lanes could not be loaded, keeps the live rows, and Retry asks again", async () => {
    listed(shellSession({ id: "a", projectId: "p1", cwd: "/w/api", name: "Live" }));
    let attempts = 0;
    bed.handlers["lanes.listArchived"] = () => {
      if (++attempts === 1) throw new Error("down");
      return {
        lanes: [
          laneView({
            id: "b-1a2b",
            projectRoot: "/w/api",
            fanoutId: FANOUT,
            state: "archived",
            archivedAt: 9,
          }),
        ],
        hasMore: false,
      };
    };
    const container = await show();
    expect(text(container)).toContain("Archived lanes could not be loaded.");
    expect(links().map((link) => link.textContent)).toEqual(["Live"]);
    await click(button(container, "Retry"));
    expect(bed.called("lanes.listArchived")).toHaveLength(2);
    expect(text(container)).not.toContain("could not be loaded");
    expect(document.querySelector('[data-recent-row="fanout"]')).not.toBeNull();
  });
});
