// @vitest-environment happy-dom
import { PROJECT_URL, sourceUrl } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import { settingsScreenEn, settingsScreenFr } from "../../i18n/catalog/settings-screen.ts";
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
  current.runtime = bed.runtime;
  localStorage.clear();
  useShellStore.getState().reset();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
  setLocale("en");
  document.documentElement.lang = "en";
  vi.restoreAllMocks();
});

async function shown(version: string | null) {
  bed.fake.setServerVersion(version);
  const page = await renderShell("/settings/account");
  await vi.waitFor(() => expect(document.querySelector("[data-settings-screen]")).not.toBeNull(), {
    timeout: 2_000,
  });
  return page;
}
const link = () => document.querySelector("[data-settings-screen] a[href^='https://']") as HTMLAnchorElement;

describe("Account section: Source code link", () => {
  it("links the tag of a release version, opening a new tab safely", async () => {
    const page = await shown("1.4.2");
    expect(link().getAttribute("href")).toBe(sourceUrl("1.4.2"));
    expect(link().getAttribute("href")).toBe(`${PROJECT_URL}/tree/v1.4.2`);
    expect(link().target).toBe("_blank");
    expect(link().rel.split(" ").sort()).toEqual(["noopener", "noreferrer"]);
    expect(link().textContent).toBe("Source code");
    expect(page.container.textContent).toContain("pap is free software under the AGPL-3.0-or-later.");
    await page.unmount();
  });

  it("links the repository root for the unreleased placeholder and before the hello frame", async () => {
    for (const version of ["0.0.0", "1.4.2-rc.1", null]) {
      const page = await shown(version);
      expect(link().getAttribute("href")).toBe(PROJECT_URL);
      await page.unmount();
    }
  });

  it("speaks French with the same link", async () => {
    setLocale("fr");
    const page = await shown("1.4.2");
    expect(link().textContent).toBe("Code source");
    expect(page.container.textContent).toContain("logiciel libre sous licence AGPL-3.0-or-later");
    expect(link().getAttribute("href")).toBe(`${PROJECT_URL}/tree/v1.4.2`);
    await page.unmount();
  });

  it("has the en and fr catalog keys", () => {
    for (const key of ["settings.source.lead", "settings.source.link"] as const) {
      expect(settingsScreenEn[key].length).toBeGreaterThan(0);
      expect(settingsScreenFr[key].length).toBeGreaterThan(0);
      expect(settingsScreenFr[key]).not.toBe(settingsScreenEn[key]);
    }
  });
});
