import { act } from "react";
import { click, press, settle } from "./dom.ts";

/** Loads the menu chunk once, so a press mounts the open menu within one tick (act cannot wait on a cold lazy chunk). */
export async function preloadMenu(): Promise<void> {
  await import("@pap/ui/overlays");
}

const menu = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="menu"]');
export const menuItems = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
];
export const menuLabels = (): string[] => menuItems().map((item) => item.textContent ?? "");

/** Opens a `LazyMenu` from its trigger: the first press mounts it open, a later one needs the keyboard (Radix opens on pointer down). */
export async function openMenu(trigger: Element): Promise<void> {
  await click(trigger);
  await settle();
  if (menu() === null) {
    await press(trigger, { key: "ArrowDown" });
    await settle();
  }
  if (menu() === null) throw new Error("the menu did not open");
}

export function menuItem(label: string): HTMLElement {
  const found = menuItems().filter((item) => item.textContent === label);
  if (found.length !== 1) throw new Error(`expected one menu item "${label}", found ${found.length}`);
  return found[0] as HTMLElement;
}

export const isDisabled = (item: HTMLElement): boolean => item.getAttribute("aria-disabled") === "true";

/** Opens the menu and chooses an item; the menu closes and focus goes back as Radix does it. */
export async function pickItem(trigger: Element, label: string): Promise<void> {
  await openMenu(trigger);
  await click(menuItem(label));
  await act(async () => {});
  await settle();
}
