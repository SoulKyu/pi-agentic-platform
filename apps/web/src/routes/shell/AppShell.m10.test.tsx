// @vitest-environment happy-dom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { useInboxStore } from "../../stores/inbox-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { useUsageStore } from "../../stores/usage-store.ts";
import { settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { limitView, usageSnapshot } from "../../testing/usage-bed.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("./HomePane.tsx", async () => {
  const { createElement } = await import("react");
  return { HomePane: () => createElement("p") };
});

beforeEach(() => {
  useTasksStore.getState().reset();
  useInboxStore.getState().reset();
  useUsageStore.getState().reset();
});

describe("sign-out wipes the tasks store (M10R43)", () => {
  it("leaves the previous account's tasks nowhere once the shell unmounts", async () => {
    const bed = fakeRuntime("idle");
    bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
    current.runtime = bed.runtime;
    const page = await renderShell("/");
    await settle();
    useTasksStore.getState().apply({
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
        {
          id: "g1",
          name: "n",
          enabled: true,
          sourceType: "manual",
          projectId: null,
          state: "ok",
          nextFireAt: null,
        },
      ],
      failures: [],
    });
    expect(useTasksStore.getState().view.triggers).toHaveLength(1);
    await page.unmount();
    expect(useTasksStore.getState().view.loaded).toBe(false);
    expect(useTasksStore.getState().view.triggers).toEqual([]);
  });

  it("does not open the tasks stream at mount: the board opens it, not the page load", async () => {
    const bed = fakeRuntime("idle");
    bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
    current.runtime = bed.runtime;
    const page = await renderShell("/");
    await settle();
    expect(bed.calls.map((call) => call.method)).not.toContain("subscribe.tasks");
    await page.unmount();
  });
});

describe("the Inbox feed of the shell (M10R50)", () => {
  async function mountShell() {
    const bed = fakeRuntime("open");
    bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
    current.runtime = bed.runtime;
    const page = await renderShell("/");
    await settle();
    return { bed, page };
  }

  it("opens the inbox stream once, when the shell mounts", async () => {
    const { bed, page } = await mountShell();
    expect(bed.called("subscribe.inbox")).toEqual([
      expect.objectContaining({ method: "subscribe.inbox", params: {} }),
    ]);
    await page.unmount();
  });

  it("fills the store from the stream, then empties it and closes the subscription at sign-out", async () => {
    const { bed, page } = await mountShell();
    await act(async () => {
      bed.emitTo("subscribe.inbox", {
        kind: "snapshot",
        items: [],
        unread: 3,
        toHandle: 1,
        truncated: false,
      });
    });
    expect(useInboxStore.getState().view).toMatchObject({ loaded: true, unread: 3, toHandle: 1 });
    await page.unmount();
    expect(useInboxStore.getState().view).toMatchObject({ loaded: false, unread: 0, toHandle: 0, items: [] });
    expect(bed.called("unsubscribe").map((call) => call.params)).toContainEqual({ sub: "s2" });
  });
});

describe("sign-out wipes the usage store (M10R107)", () => {
  it("leaves no limit, spend or budget behind for the next account", async () => {
    const bed = fakeRuntime("idle");
    bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
    current.runtime = bed.runtime;
    const page = await renderShell("/");
    await settle();
    useUsageStore.getState().apply(usageSnapshot([limitView()], { todayUsd: 3, budgetUsd: 9 }));
    expect(useUsageStore.getState().view.limits.size).toBe(1);

    await page.unmount();

    expect(useUsageStore.getState().view).toMatchObject({ loaded: false, todayUsd: 0, budgetUsd: null });
    expect(useUsageStore.getState().view.limits.size).toBe(0);
  });
});
