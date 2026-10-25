// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
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
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  const bed = fakeRuntime("open");
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NAV = 'nav[aria-label="Settings sections"]';
async function shown(path: string, options: Parameters<typeof renderShell>[1]) {
  const page = await renderShell(path, options);
  await vi.waitFor(() => expect(document.querySelector("[data-settings-screen]")).not.toBeNull(), {
    timeout: 2_000,
  });
  return page;
}
const groups = () =>
  [...document.querySelectorAll(`${NAV} [role="group"]`)].map((group) => ({
    name: group.querySelector("p")?.textContent,
    links: [...group.querySelectorAll("a")].map((link) => link.textContent),
  }));

describe("Settings groups", () => {
  it("the nav shows You, Work and This pap, and no Personal", async () => {
    const page = await shown("/settings/language", { role: "owner" });
    expect(groups().map((group) => group.name)).toEqual(["You", "Work", "This pap"]);
    expect(document.querySelector(NAV)?.textContent).not.toContain("Personal");
    expect(groups()[0]?.links).toEqual([
      "Appearance",
      "Keyboard shortcuts",
      "Language",
      "Notifications",
      "Account & devices",
    ]);
    await page.unmount();
  });

  it("a member sees You, Work and This pap with Health only, and a deep link to an owner section opens Appearance", async () => {
    const page = await shown("/settings/language", { role: "member" });
    expect(groups().find((group) => group.name === "This pap")?.links).toEqual(["Health"]);
    await page.unmount();
    const link = await shown("/settings/users", { role: "member" });
    expect(link.container.querySelector("h1")?.textContent).toBe("Appearance");
    await link.unmount();
  });

  it("the phone select lists sections in group order", async () => {
    const page = await shown("/settings/language", { phone: true, role: "owner" });
    const trigger = document.querySelector('[role="combobox"]') as HTMLElement;
    await act(async () => {
      trigger.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
      );
    });
    await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull(), {
      timeout: 2_000,
    });
    const labels = [...document.querySelectorAll('[role="option"]')].map((one) => one.textContent);
    expect(labels).toEqual([
      "Appearance",
      "Keyboard shortcuts",
      "Language",
      "Notifications",
      "Account & devices",
      "Agents",
      "Approvals",
      "Automation",
      "GitHub",
      "Models",
      "MCP servers",
      "Skills",
      "Users",
      "Health",
    ]);
    await page.unmount();
  });

  it("a column section's body is max-w-settings", async () => {
    const page = await shown("/settings/approvals", { role: "owner" });
    expect(
      document.querySelector('[data-settings-body="column"]')?.classList.contains("max-w-settings"),
    ).toBe(true);
    await page.unmount();
  });
});
