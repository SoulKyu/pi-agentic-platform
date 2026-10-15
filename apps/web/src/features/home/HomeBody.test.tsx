// @vitest-environment happy-dom
import { DEFAULT_HOME_LAYOUT, type HomeLayout } from "@pap/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { mount, settle } from "../../testing/dom.ts";
import { fakeHomeActions, SHORTCUTS } from "../../testing/home-actions.ts";
import { usageSummary } from "../../testing/home-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellProject, shellSnapshot } from "../../testing/shell-snapshot.ts";
import HomeBody from "./HomeBody.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const api = shellProject({ id: "p1", name: "api", root: "/w/api", sessions: 1 });
const parts = () => ({
  actions: document.querySelector("[data-home-actions]") !== null,
  status: document.querySelector("[data-home-status]") !== null,
  recent: [...document.querySelectorAll("h2")].some((node) => node.textContent === "Recent work"),
});

beforeEach(() => {
  const bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["usage.summary"] = () => usageSummary();
  bed.handlers["lanes.listArchived"] = () => ({ lanes: [], hasMore: false });
  bed.handlers["files.list"] = () => ({ entries: [], truncated: false });
  useShellStore.getState().reset();
  useShellStore.getState().apply(shellSnapshot([], { projects: [api] }));
});

describe("the home's body (§3.2–§3.4, §6)", () => {
  it("shows the action row, the status line and Recent work, and hides each part Settings › Home hides", async () => {
    const actions = fakeHomeActions();
    const body = (layout: HomeLayout) => (
      <HomeBody project={api} layout={layout} actions={actions} shortcuts={SHORTCUTS} />
    );
    const page = await mount(body(DEFAULT_HOME_LAYOUT));
    await settle();
    expect(document.querySelector("[data-home-body]")).not.toBeNull();
    expect(parts()).toEqual({ actions: true, status: true, recent: true });
    await page.rerender(body({ ...DEFAULT_HOME_LAYOUT, status: false }));
    expect(parts()).toEqual({ actions: true, status: false, recent: true });
    await page.rerender(body({ ...DEFAULT_HOME_LAYOUT, recent: false }));
    expect(parts()).toEqual({ actions: true, status: true, recent: false });
    await page.rerender(
      body({ ...DEFAULT_HOME_LAYOUT, explore: false, automate: false, project: false, help: false }),
    );
    expect(parts()).toEqual({ actions: false, status: true, recent: true });
  });
});
