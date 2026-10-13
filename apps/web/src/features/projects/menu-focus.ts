import { useEffect } from "react";

/** The menu button that gets the focus back once the change it started is settled (null: none waits). */
let wanted: string | null = null;

export const wantFocus = (key: string | null): void => {
  wanted = key;
};

const triggerOf = (key: string): HTMLElement | null =>
  [...document.querySelectorAll<HTMLElement>("[data-menu-key]")].find((el) => el.dataset.menuKey === key) ??
  null;

/**
 * After each render of a menu: when its button is the one waiting and no change is pending, it takes the focus.
 * The button is disabled while a change saves, so the focus the menu closing gave it is gone by then.
 */
export function useMenuFocus(key: string, pending: boolean): void {
  useEffect(() => {
    if (pending || wanted !== key) return;
    const trigger = triggerOf(key);
    if (trigger === null || trigger.hasAttribute("disabled")) return;
    wanted = null;
    trigger.focus();
  });
}

/** After each render of the tree: when the waiting button is gone (its row left the list), `fallback` takes the focus. */
export function useFocusFallback(pending: boolean, fallback: () => HTMLElement | null): void {
  useEffect(() => {
    if (pending || wanted === null || triggerOf(wanted) !== null) return;
    wanted = null;
    fallback()?.focus();
  });
}
