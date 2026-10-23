// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, SETTINGS_SECTIONS, useWorkspaceStore } from "../../features/workspace/index.ts";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useHealthStore } from "../../stores/health-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";

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
  current.runtime = bed.runtime;
  localStorage.clear();
  useShellStore.getState().reset();
  useHealthStore.getState().reset();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
  setLocale("en");
  vi.restoreAllMocks();
});

describe("Health section", () => {
  it("is a settings section, after Automation", () => {
    expect(SETTINGS_SECTIONS.indexOf("health")).toBe(SETTINGS_SECTIONS.indexOf("automation") + 1);
  });

  it("is reachable at /settings/health and opens the ops subscription once, unsubscribing on unmount", async () => {
    let opsSub = "";
    bed.handlers["subscribe.ops"] = () => ({ sub: (opsSub = "ops-sub") });
    const page = await renderShell("/settings/health");
    await vi.waitFor(() => expect(page.container.querySelector("[data-health-section]")).not.toBeNull(), {
      timeout: 5_000,
    });
    expect(page.container.querySelector("h1")?.textContent).toBe("Health");
    expect(
      page.container.querySelector('nav[aria-label="Settings sections"] a[aria-current="page"]')?.textContent,
    ).toBe("Health");
    expect(bed.called("subscribe.ops")).toHaveLength(1);
    expect(bed.called("ops.events.list")).toHaveLength(0);
    await page.unmount();
    expect(
      bed.called("unsubscribe").filter((call) => (call.params as { sub: string }).sub === opsSub),
    ).toHaveLength(1);
  });

  it("opens nothing of it while another section is shown", async () => {
    const page = await renderShell("/settings/language");
    await vi.waitFor(() => expect(document.querySelector("[data-settings-screen]")).not.toBeNull(), {
      timeout: 2_000,
    });
    expect(bed.called("subscribe.ops")).toHaveLength(0);
    expect(page.container.querySelector("[data-health-section]")).toBeNull();
    await page.unmount();
  });
});
