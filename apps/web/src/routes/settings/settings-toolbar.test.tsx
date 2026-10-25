// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { duplicateNames } from "../../testing/names.ts";
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
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  const bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  bed.handlers["usage.summary"] = () => ({
    from: 1,
    to: 2,
    timeZone: "UTC",
    totals: { costUsd: 0, tokens: 0, runs: 0 },
    byOrigin: [],
    byModel: [],
    metrics: true,
    otlpHost: null,
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function shown(path: string) {
  const page = await renderShell(path);
  await vi.waitFor(() => expect(document.querySelector("[data-settings-screen]")).not.toBeNull(), {
    timeout: 2_000,
  });
  return page;
}

describe("Settings toolbar", () => {
  it("Appearance's Reset sits in the header beside the h1, and no heading repeats the section name", async () => {
    const page = await shown("/settings/appearance");
    const header = document.querySelector("[data-settings-screen] header") as HTMLElement;
    await vi.waitFor(() => expect(header.querySelector("button")?.textContent).toBe("Reset to defaults"), {
      timeout: 2_000,
    });
    expect(header.querySelector("h1")?.textContent).toBe("Appearance");
    expect(duplicateNames(document.querySelector("[data-settings-screen] section") as HTMLElement)).toEqual(
      [],
    );
    await page.unmount();
  });

  it("Automation has no h2 named Automation", async () => {
    const page = await shown("/settings/automation");
    await vi.waitFor(() => expect(document.querySelector("[data-automation-section]")).not.toBeNull(), {
      timeout: 2_000,
    });
    const names = [...page.container.querySelectorAll("h2")].map((h) => h.textContent);
    expect(names).not.toContain("Automation");
    await page.unmount();
  });
});
