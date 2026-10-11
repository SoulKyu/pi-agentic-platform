// @vitest-environment happy-dom
import { isValidElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { useSessionsCache } from "../shell/sessions-cache.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
const auth = vi.hoisted(() => ({ logout: vi.fn(), registerPasskey: vi.fn() }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../../features/auth/auth-api.ts", async (original) => ({
  ...(await original<typeof import("../../features/auth/auth-api.ts")>()),
  logout: auth.logout,
  registerPasskey: auth.registerPasskey,
}));
vi.mock("../../features/sessions/SessionListScreen.tsx", async () => {
  const { createElement } = await import("react");
  return { SessionListScreen: () => createElement("p", { "data-stub": "home" }) };
});

let started: Array<{ stop(): void }> = [];
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  const bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useSessionsCache.setState({ sessions: [], status: "idle" });
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
  auth.logout.mockReset().mockResolvedValue(undefined);
  auth.registerPasskey.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
  setLocale("en");
  document.documentElement.lang = "en";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the settings pane", () => {
  it("shows the Settings screen once its chunk has loaded", async () => {
    const page = await renderShell("/settings/language");
    await vi.waitFor(
      () =>
        expect(
          page.container.querySelector('[data-pane-kind="settings"] [data-settings-screen]'),
        ).not.toBeNull(),
      { timeout: 2_000 },
    );
    await page.unmount();
  });
});

describe("the dev-ui pane", () => {
  it("shows the gallery in development", async () => {
    const page = await renderShell("/dev/ui");
    await vi.waitFor(
      () =>
        expect(
          page.container.querySelector('[data-pane-kind="dev-ui"] [data-gallery-section]'),
        ).not.toBeNull(),
      { timeout: 5_000 },
    );
    await page.unmount();
  });

  it("answers /dev/ui with the not-found screen in production, with no gallery in the page (ADR 0011)", async () => {
    vi.stubEnv("DEV", false);
    try {
      const page = await renderShell("/dev/ui");
      expect(page.container.querySelector('[data-slot="empty-state"]')?.textContent).toContain(
        "This page does not exist",
      );
      expect(page.container.querySelector("[data-gallery-section]")).toBeNull();
      await page.unmount();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("builds the pane renderer without a gallery in a production build (ADR 0011)", async () => {
    vi.stubEnv("DEV", false);
    vi.resetModules();
    try {
      const { renderItem } = await import("./pane-renderers.tsx");
      const { NotFound } = await import("./NotFound.tsx");
      const shown = renderItem({ kind: "dev-ui" });
      expect(isValidElement(shown) && shown.type).toBe(NotFound);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
