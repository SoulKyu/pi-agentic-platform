// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { press, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { useShellStore } from "../../stores/shell-store.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../../features/sessions/SessionListScreen.tsx", async () => {
  const { createElement } = await import("react");
  return { SessionListScreen: () => createElement("p", { "data-stub": "home" }) };
});

let started: Array<{ stop(): void }> = [];
let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useShellStore.getState().reset();
  useTasksStore.getState().reset();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
});

const ctrlK = () => press(document.body, { key: "k", code: "KeyK", ctrlKey: true });
const listbox = () => document.querySelector('[role="listbox"]');
const paneKind = (kind: string) => document.querySelector(`[data-pane-kind="${kind}"]`);
const snapshot = (name: string) => ({
  kind: "snapshot",
  paused: false,
  slots: 2,
  running: 0,
  queued: 0,
  quietHours: false,
  todayUsd: 0,
  budgetUsd: null,
  tasks: [],
  truncated: false,
  triggers: [
    { id: "g1", name, enabled: true, sourceType: "manual", projectId: null, state: "ok", nextFireAt: null },
  ],
  failures: [],
});

describe("the tasks subscription follows the palette and the Tasks panes (RT-31)", () => {
  it("is not opened at shell mount", async () => {
    const page = await renderShell("/");
    await settle();
    expect(bed.called("subscribe.tasks")).toEqual([]);
    await page.unmount();
  });

  it("opens with the palette and closes with it", async () => {
    const page = await renderShell("/");
    await settle();
    await ctrlK();
    await vi.waitFor(() => expect(listbox()).not.toBeNull(), { timeout: 2_000 });
    await settle();
    expect(bed.called("subscribe.tasks")).toHaveLength(1);
    await act(async () => bed.emitTo("subscribe.tasks", snapshot("prod-alerts")));
    expect([...document.querySelectorAll('[role="option"]')].map((el) => el.textContent)).toContain(
      "Trigger · prod-alerts",
    );
    await ctrlK();
    await settle();
    expect(bed.called("unsubscribe")).toHaveLength(1);
    // The store keeps its last snapshot until sign-out.
    expect(useTasksStore.getState().view.triggers).toHaveLength(1);
    await page.unmount();
  });

  it("opens with a Tasks pane and closes when the pane is gone", async () => {
    const page = await renderShell("/tasks");
    await vi.waitFor(() => expect(paneKind("tasks")).not.toBeNull());
    await settle();
    expect(bed.called("subscribe.tasks")).toHaveLength(1);
    await act(async () => useWorkspaceStore.getState().close("tasks"));
    await settle();
    expect(bed.called("unsubscribe")).toHaveLength(1);
    await page.unmount();
  });

  it("opens once for a Trigger pane and a palette together, and closes only when both are gone", async () => {
    const page = await renderShell("/trigger/g1");
    await vi.waitFor(() => expect(paneKind("trigger")).not.toBeNull());
    await settle();
    await ctrlK();
    await vi.waitFor(() => expect(listbox()).not.toBeNull(), { timeout: 2_000 });
    await settle();
    expect(bed.called("subscribe.tasks")).toHaveLength(1);
    await ctrlK();
    await settle();
    expect(bed.called("unsubscribe")).toHaveLength(0);
    await act(async () => useWorkspaceStore.getState().close("trigger:g1"));
    await settle();
    expect(bed.called("unsubscribe")).toHaveLength(1);
    await page.unmount();
  });

  it("titles a trigger tab by its name once the store knows it", async () => {
    const page = await renderShell("/trigger/g1");
    await vi.waitFor(() => expect(paneKind("trigger")).not.toBeNull());
    await settle();
    await act(async () => bed.emitTo("subscribe.tasks", snapshot("prod-alerts")));
    expect(document.querySelector('[role="tab"]')?.textContent).toContain("prod-alerts");
    await page.unmount();
  });
});
