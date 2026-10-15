// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, pathOfItem, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTriggerPrefill } from "../../stores/trigger-prefill.ts";
import { field, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { shellProject, shellSnapshot } from "../../testing/shell-snapshot.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("./HomePane.tsx", async () => {
  const { createElement } = await import("react");
  return { HomePane: () => createElement("p", { "data-stub": "home" }) };
});

let started: Array<{ stop(): void }> = [];
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  const bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useShellStore.getState().reset();
  useShellStore.getState().apply(
    shellSnapshot([], {
      projects: [shellProject({ id: "p1", name: "atlas", root: "/work/atlas", sessions: 1 })],
    }),
  );
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
  useTriggerPrefill.setState({ items: {} });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
});

describe("a new trigger's pane (decision 85)", () => {
  it(
    "opens the editor with the name and prompt the home left, then forgets them",
    { timeout: 20_000 },
    async () => {
      useTriggerPrefill.getState().put("p1", { name: "Nightly report", prompt: "Summarise the failures" });
      const page = await renderShell(pathOfItem({ kind: "trigger", id: "new:p1" }));
      await vi.waitFor(() => expect(document.querySelector("[data-trigger-pane]")).not.toBeNull(), {
        timeout: 10_000,
      });
      await settle();
      expect((field(page.container, "Name") as HTMLInputElement).value).toBe("Nightly report");
      expect((field(page.container, "Prompt") as HTMLTextAreaElement).value).toBe("Summarise the failures");
      expect(useTriggerPrefill.getState().items).toEqual({});
      await page.unmount();
    },
  );

  it(
    "applies a second launch while the pane is already open, and forgets it too",
    { timeout: 20_000 },
    async () => {
      useTriggerPrefill.getState().put("p1", { name: "First", prompt: "One" });
      const page = await renderShell(pathOfItem({ kind: "trigger", id: "new:p1" }));
      await vi.waitFor(() => expect(document.querySelector("[data-trigger-pane]")).not.toBeNull(), {
        timeout: 10_000,
      });
      await settle();
      expect((field(page.container, "Name") as HTMLInputElement).value).toBe("First");
      await act(async () => useTriggerPrefill.getState().put("p1", { name: "Second", prompt: "Two" }));
      await settle();
      expect((field(page.container, "Name") as HTMLInputElement).value).toBe("Second");
      expect((field(page.container, "Prompt") as HTMLTextAreaElement).value).toBe("Two");
      expect(useTriggerPrefill.getState().items).toEqual({});
      await page.unmount();
    },
  );
});
