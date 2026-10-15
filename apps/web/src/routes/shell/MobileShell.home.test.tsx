// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import { runCommand } from "../../lib/command-registry.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { button, click, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { shellSnapshot } from "../../testing/shell-snapshot.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
const auth = vi.hoisted(() => ({ logout: vi.fn() }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../../features/auth/auth-api.ts", async (original) => ({
  ...(await original<typeof import("../../features/auth/auth-api.ts")>()),
  logout: auth.logout,
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
  useShellStore.getState().apply(shellSnapshot([]));
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
  auth.logout.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
  vi.unstubAllGlobals();
});

// On a phone the menu is a bottom sheet (a dialog of buttons), not a popup menu.
const sheetRows = () =>
  [...document.querySelectorAll('[role="dialog"] button')].filter(
    (row) => row.getAttribute("aria-label") !== "Close",
  );
const menuRows = () => sheetRows().map((row) => row.textContent);
async function openListsMenu(container: HTMLElement) {
  await click(button(container, "Lists"));
  await click(button(container, "Settings and account"));
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull(), { timeout: 2000 });
}

describe("the phone's minimum entries (§5)", () => {
  it("the logo and + go to the home", async () => {
    const page = await renderShell("/settings/appearance", { phone: true, chunks: ["menu"] });
    await settle();
    const logo = page.container.querySelector('header a[href="/"]') as HTMLAnchorElement;
    expect(logo.getAttribute("aria-label")).toBe("pap");
    await click(logo);
    await settle();
    expect(page.router.state.location.pathname).toBe("/");
    await act(async () =>
      page.router.navigate({ to: "/settings/$section", params: { section: "appearance" } }),
    );
    await settle();
    await click(button(page.container, "New session"));
    await settle();
    expect(page.router.state.location.pathname).toBe("/");
    await page.unmount();
  });

  it("the Lists tab's menu reaches Settings and the account without the palette", async () => {
    const onSignedOut = vi.fn();
    const page = await renderShell("/", { phone: true, onSignedOut, chunks: ["menu"] });
    await settle();
    await openListsMenu(page.container);
    expect(menuRows()).toEqual(["Settings", "ana", "Sign out"]);
    await click(sheetRows().find((row) => row.textContent === "Settings") as HTMLElement);
    await settle();
    expect(page.router.state.location.pathname).toBe("/settings/appearance");
    await openListsMenu(page.container);
    await click(sheetRows().find((row) => row.textContent === "Sign out") as HTMLElement);
    await settle();
    expect(auth.logout).toHaveBeenCalledOnce();
    expect(onSignedOut).toHaveBeenCalledOnce();
    await page.unmount();
  });

  it("the logo and + leave the Lists section even when already at the home", async () => {
    const page = await renderShell("/", { phone: true });
    await settle();
    for (const control of [
      () => page.container.querySelector('header a[href="/"]') as HTMLElement,
      () => button(page.container, "New session"),
    ]) {
      await click(button(page.container, "Lists"));
      expect(button(page.container, "Lists").getAttribute("aria-current")).toBe("page");
      await click(control());
      await settle();
      expect(button(page.container, "Work").getAttribute("aria-current")).toBe("page");
    }
    await page.unmount();
  });

  it("Settings from the Lists menu shows Settings when already on it", async () => {
    const page = await renderShell("/settings/appearance", { phone: true, chunks: ["menu"] });
    await settle();
    await openListsMenu(page.container);
    await click(sheetRows().find((row) => row.textContent === "Settings") as HTMLElement);
    await settle();
    expect(button(page.container, "Work").getAttribute("aria-current")).toBe("page");
    await page.unmount();
  });

  it("mobile.inbox.open shows the Inbox section", async () => {
    const page = await renderShell("/", { phone: true });
    await settle();
    await act(async () => void runCommand("mobile.inbox.open"));
    expect(button(page.container, "Inbox").getAttribute("aria-current")).toBe("page");
    await page.unmount();
  });
});
