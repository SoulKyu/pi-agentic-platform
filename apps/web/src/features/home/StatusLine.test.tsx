// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useInboxStore } from "../../stores/inbox-store.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { click, mount, settle } from "../../testing/dom.ts";
import { fakeHomeActions } from "../../testing/home-actions.ts";
import { tasksSnapshot, taskView, usageSummary } from "../../testing/home-fixtures.ts";
import { laneSnapshot, laneView } from "../../testing/lane-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellProject } from "../../testing/shell-snapshot.ts";
import { StatusLine } from "./StatusLine.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const api = shellProject({ id: "p1", name: "api", root: "/w/api", sessions: 1 });
let bed: ReturnType<typeof fakeRuntime>;
let actions: ReturnType<typeof fakeHomeActions>;
const line = () => document.querySelector("[data-home-status]") as HTMLElement | null;
const parts = () => [...(line()?.querySelectorAll("a, button") ?? [])];
const words = () => parts().map((node) => node.textContent);
const show = async (project: typeof api | null = api) => {
  await mount(<StatusLine project={project} actions={actions} />);
  await settle();
};
const busyProject = () => {
  useLaneStore
    .getState()
    .apply(
      laneSnapshot([
        laneView({ id: "a-1a2b", projectRoot: "/w/api" }),
        laneView({ id: "b-1a2b", projectRoot: "/w/api" }),
        laneView({ id: "c-1a2b", projectRoot: "/w/api" }),
        laneView({ id: "d-1a2b", projectRoot: "/w/web" }),
      ]),
    );
  useTasksStore.getState().apply(tasksSnapshot([taskView({ id: "t1", state: "running" })]));
  useInboxStore.getState().apply({ kind: "counts", unread: 3, toHandle: 1 });
};

beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["usage.summary"] = () => usageSummary({ costUsd: 4.2, runs: 3 });
  actions = fakeHomeActions();
  useLaneStore.getState().reset();
  useTasksStore.getState().reset();
  useInboxStore.getState().reset();
});
afterEach(() => setLocale("en"));

describe("the status line (§3.3)", () => {
  it("reads 3 active lanes · 1 running task · Inbox 3 · 30 days $4.20, the spend owner-wide", async () => {
    busyProject();
    await show();
    expect(words()).toEqual([
      "3 active lanes",
      "1 running task",
      "Inbox 3",
      "30 days $4.20 All your projects, last 30 days",
    ]);
    expect(bed.called("usage.summary").map((call) => call.params)).toEqual([{ range: "30d" }]);
  });

  it("leaves out a part with nothing to show, never the spend, which says no spend yet", async () => {
    bed.handlers["usage.summary"] = () => usageSummary({ runs: 0 });
    await show();
    expect(words()).toEqual(["No spend yet All your projects, last 30 days"]);
  });

  it("says API-equivalent when a subscription paid for part of it", async () => {
    bed.handlers["usage.summary"] = () => usageSummary({ costUsd: 4.2, runs: 2, billing: "subscription" });
    await show();
    expect(words()).toEqual(["30 days $4.20 (API-equivalent) All your projects, last 30 days"]);
  });

  it("goes on without its spend when the summary fails", async () => {
    busyProject();
    bed.handlers["usage.summary"] = () => {
      throw new RpcError("timeout");
    };
    await show();
    expect(words()).toEqual(["3 active lanes", "1 running task", "Inbox 3"]);
  });

  it("opens each part's view: the tree, the tasks board, the Inbox, Settings › Automation", async () => {
    busyProject();
    await show();
    const [lanes, tasks, inbox, spend] = parts() as HTMLElement[];
    expect(lanes?.tagName).toBe("BUTTON");
    expect(tasks?.getAttribute("href")).toBe("/tasks");
    expect(spend?.getAttribute("href")).toBe("/settings/automation");
    for (const part of [lanes, tasks, inbox, spend]) await click(part as HTMLElement);
    expect(actions.openTree).toHaveBeenCalledOnce();
    expect(actions.openInbox).toHaveBeenCalledOnce();
    expect(actions.open.mock.calls).toEqual([
      [{ kind: "tasks" }],
      [{ kind: "settings", section: "automation" }],
    ]);
  });

  it("leaves a modified or non-primary click to the browser, so a new tab works", async () => {
    busyProject();
    await show();
    const tasks = parts()[1] as HTMLElement;
    for (const init of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
      await act(async () => {
        tasks.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(actions.open).not.toHaveBeenCalled();
    const plain = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      tasks.dispatchEvent(plain);
    });
    expect(plain.defaultPrevented).toBe(true);
    expect(actions.open).toHaveBeenCalledOnce();
  });

  it("speaks French", async () => {
    setLocale("fr");
    busyProject();
    await show();
    expect(words()[0]).toBe("3 lanes actives");
    expect(words()[3]).toBe("30 jours $4.20 Tous vos projets, 30 derniers jours");
  });
});
