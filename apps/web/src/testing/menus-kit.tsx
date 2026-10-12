// Helpers for the menu tests: the tree mounted with a toaster, its menus opened and chosen from, its toasts read.
import type { ShellSession } from "@pap/contracts";
import { Toaster } from "@pap/ui";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { expect, vi } from "vitest";
import { useShellStore } from "../stores/shell-store.ts";
import { click, mount, press, settle } from "./dom.ts";
import { shellSnapshot } from "./shell-snapshot.ts";
import ProjectTree from "../features/projects/ProjectTree.tsx";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const load = (sessions: ShellSession[], patch: Parameters<typeof shellSnapshot>[1] = {}) =>
  act(async () => useShellStore.getState().apply(shellSnapshot(sessions, patch)));

let lastRouter: { state: { location: { pathname: string } } } | null = null;
/** Where the last `show()` router is now. */
export const currentPath = (): string => lastRouter?.state.location.pathname ?? "";

export async function show(at = "/", onNewSession: () => void = () => {}) {
  const Tree = () => (
    <>
      <Toaster closeLabel="Close" regionLabel="Notifications" />
      <ProjectTree onPick={() => {}} onNewSession={onNewSession} chord="Ctrl+K" />
    </>
  );
  const root = createRootRoute({ component: Tree });
  const index = createRoute({ getParentRoute: () => root, path: "/", component: () => null });
  const session = createRoute({ getParentRoute: () => root, path: "/s/$sessionId", component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([index, session]),
    history: createMemoryHistory({ initialEntries: [at] }),
  });
  lastRouter = router;
  const page = await mount(<RouterProvider router={router} />);
  await settle();
  return page.container;
}

export const rowOf = (box: HTMLElement, label: string): HTMLElement => {
  const found = [...box.querySelectorAll("li")].find(
    (li) => li.querySelector("[data-session-label]")?.textContent === label,
  );
  if (!found) throw new Error(`no row ${label}`);
  return found;
};
export const sessionTrigger = (box: HTMLElement, label: string): HTMLButtonElement =>
  rowOf(box, label).querySelector('button[aria-label="Session actions"]') as HTMLButtonElement;
export const projectTrigger = (box: HTMLElement, name: string): HTMLButtonElement => {
  const section = [...box.querySelectorAll("section[data-group]")].find(
    (s) => s.querySelector("h3")?.textContent === name,
  );
  return section?.querySelector('button[aria-label="Project actions"]') as HTMLButtonElement;
};
export const menuItems = () =>
  [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
export async function openMenu(trigger: HTMLElement) {
  // The first press asks for the menu's chunk; once it is mounted, Radix opens on the keyboard (a bare click does not).
  if (trigger.hasAttribute("aria-haspopup")) await press(trigger, { key: "Enter" });
  else await click(trigger);
  await act(async () => {
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull(), { timeout: 2000 });
  });
}
export async function choose(label: string) {
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent === label);
  if (!item) throw new Error(`no menu item ${label}`);
  await click(item);
  await settle();
}
export const toasts = () => [...document.querySelectorAll('[data-slot="toast"]')];
export const toastTexts = () => toasts().map((entry) => entry.textContent);
export const undoButton = () =>
  [...document.querySelectorAll('[data-slot="toast"] button')].find(
    (b) => b.textContent === "Undo",
  ) as HTMLElement;
export const deferred = () => {
  let resolve: (value: unknown) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
};
export const noState = {
  pinned: false,
  pinBefore: null,
  archived: false,
  settled: false,
  snoozedUntil: null,
};

/** Closes the toasts a test left, so the next one starts without any. */
export async function closeToasts(): Promise<void> {
  for (const close of document.querySelectorAll('[data-slot="toast"] button[aria-label="Close"]'))
    await click(close);
}
