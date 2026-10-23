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
  bed.handlers["push.config"] = () => ({
    publicKey: null,
    status: "off",
    reason: "insecure_http",
    readiness: { status: "insecure_http", hint: "Open pap over HTTPS." },
    subscribed: 0,
    max: 10,
    lastFailure: null,
    keysReset: null,
  });
  bed.handlers["push.list"] = () => ({ items: [] });
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

describe("Notifications section (M12)", () => {
  it("is a settings section, after Agents and before Account", () => {
    const at = SETTINGS_SECTIONS.indexOf("notifications");
    expect(at).toBe(SETTINGS_SECTIONS.indexOf("agents") + 1);
    expect(SETTINGS_SECTIONS[at + 1]).toBe("account");
  });

  it("is reachable at /settings/notifications, in a chunk of its own, and reads the push state", async () => {
    const page = await renderShell("/settings/notifications");
    await vi.waitFor(
      () => expect(page.container.querySelector("[data-notifications-settings]")).not.toBeNull(),
      { timeout: 5_000 },
    );
    expect(page.container.querySelector("h1")?.textContent).toBe("Notifications");
    expect(bed.called("push.config")).toHaveLength(1);
    expect(bed.called("push.list")).toHaveLength(1);
    expect(page.container.textContent).toContain("Open pap over HTTPS.");
    await page.unmount();
  });

  it("links the quiet-hours line to Settings > Automation", async () => {
    const page = await renderShell("/settings/notifications");
    await vi.waitFor(
      () => expect(page.container.querySelector("[data-notifications-settings]")).not.toBeNull(),
      { timeout: 5_000 },
    );
    expect(
      page.container.querySelector('[data-notifications-settings] a[href="/settings/automation"]'),
    ).not.toBeNull();
    await page.unmount();
  });

  it("is named in French in the navigation", async () => {
    setLocale("fr");
    const page = await renderShell("/settings/notifications");
    await vi.waitFor(() => expect(page.container.querySelector("h1")?.textContent).toBe("Notifications"));
    await page.unmount();
  });
});
