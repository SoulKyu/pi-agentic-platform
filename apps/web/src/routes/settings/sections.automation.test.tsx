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
import { useUsageStore } from "../../stores/usage-store.ts";

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
const summary = {
  from: 1,
  to: 2,
  timeZone: "UTC",
  totals: { costUsd: 0.5, tokens: 100, runs: 2 },
  byOrigin: [{ origin: "user", costUsd: 0.5, tokens: 100, runs: 2 }],
  byModel: [{ provider: "faux", model: "m", billing: "api", costUsd: 0.5, tokens: 100, runs: 2 }],
  metrics: true,
  otlpHost: null,
};
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  bed.handlers["usage.summary"] = () => summary;
  current.runtime = bed.runtime;
  localStorage.clear();
  useShellStore.getState().reset();
  useUsageStore.getState().reset();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
  setLocale("en");
  vi.restoreAllMocks();
});

describe("Automation section", () => {
  it("is a settings section, after Skills", () => {
    expect(SETTINGS_SECTIONS.indexOf("automation")).toBe(SETTINGS_SECTIONS.indexOf("skills") + 1);
  });

  it("is reachable at /settings/automation, in a chunk of its own, and reads the setting and the spending", async () => {
    const page = await renderShell("/settings/automation");
    await vi.waitFor(() => expect(page.container.querySelector("[data-automation-section]")).not.toBeNull(), {
      timeout: 5_000,
    });
    await vi.waitFor(() => expect(page.container.querySelector("[data-automation-form]")).not.toBeNull(), {
      timeout: 5_000,
    });
    expect(page.container.querySelector("h1")?.textContent).toBe("Automation");
    expect(
      page.container.querySelector('nav[aria-label="Settings sections"] a[aria-current="page"]')?.textContent,
    ).toBe("Automation");
    expect(
      bed.called("settings.get").filter((call) => (call.params as { key: string }).key === "automation"),
    ).toHaveLength(1);
    expect(bed.called("usage.summary").map((call) => call.params)).toEqual([{ range: "today" }]);
    // Both streams are opened by the section, not by the page load.
    expect(bed.called("subscribe.tasks")).toHaveLength(1);
    expect(bed.called("subscribe.usage")).toHaveLength(1);
    expect(page.container.querySelector("[data-observability]")?.textContent).toContain(
      "Prometheus /metrics: on",
    );
    expect(page.container.querySelector('[data-spending] a[href="/settings/models"]')?.textContent).toBe(
      "Settings › Models",
    );
    await page.unmount();
  });

  it("opens nothing of it while another section is shown", async () => {
    const page = await renderShell("/settings/language");
    await vi.waitFor(() => expect(document.querySelector("[data-settings-screen]")).not.toBeNull(), {
      timeout: 2_000,
    });
    expect(bed.called("usage.summary")).toHaveLength(0);
    expect(
      bed.called("settings.get").filter((call) => (call.params as { key: string }).key === "automation"),
    ).toHaveLength(0);
    expect(page.container.querySelector("[data-automation-section]")).toBeNull();
    await page.unmount();
  });
});
