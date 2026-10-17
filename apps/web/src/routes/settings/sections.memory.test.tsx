// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, SETTINGS_SECTIONS, useWorkspaceStore } from "../../features/workspace/index.ts";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { useShellStore } from "../../stores/shell-store.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../shell/HomePane.tsx", async () => {
  const { createElement } = await import("react");
  return { HomePane: () => createElement("p", { "data-stub": "home" }) };
});

let started: Array<{ stop(): void }> = [];
let bed = fakeRuntime("open");
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  bed.handlers["memory.status"] = () => ({
    installed: false,
    watcher: "unknown",
    checkedAt: null,
    lastCaptureError: null,
    lastCaptureAt: null,
  });
  current.runtime = bed.runtime;
  localStorage.clear();
  useShellStore.getState().reset();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
  setLocale("en");
  vi.restoreAllMocks();
});

describe("Memory section (M11R150)", () => {
  it("is a settings section, after Agents", () => {
    expect(SETTINGS_SECTIONS.indexOf("memory")).toBe(SETTINGS_SECTIONS.indexOf("agents") + 1);
  });

  it("is reachable at /settings/memory, in a chunk of its own, and reads pi-mem0's state", async () => {
    const page = await renderShell("/settings/memory");
    await vi.waitFor(() => expect(page.container.querySelector("[data-memory-settings]")).not.toBeNull(), {
      timeout: 5_000,
    });
    expect(page.container.querySelector("h1")?.textContent).toBe("Memory");
    expect(bed.called("memory.status")).toHaveLength(1);
    expect(page.container.textContent).toContain("pi-mem0 is not installed");
    await page.unmount();
  });
});
