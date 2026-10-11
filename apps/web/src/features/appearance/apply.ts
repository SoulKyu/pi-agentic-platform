import { THEME_TOKENS } from "@pap/ui";
import { reportClientIssue } from "../../lib/report.ts";
import { APPEARANCE_ATTRS, type BootCache, type ResolvedAppearance } from "./model.ts";

export const BOOT_KEY = "pap.appearance.boot";

/** The only custom properties the appearance writes inline: a custom theme's tokens and the device sizes. */
export const BOOT_VAR_NAMES: ReadonlySet<string> = new Set([
  ...THEME_TOKENS.map((name) => `--${name}`),
  "--size-ui",
  "--size-chat",
  "--size-code",
]);

/**
 * The appearance variables already inline (set by the boot script), so the first apply removes those the app no
 * longer resolves (M3-RT-11). Other inline variables, such as --app-viewport-height, are not the appearance's.
 */
export function inlineAppearanceVars(root: HTMLElement): Set<string> {
  const names = new Set<string>();
  for (const declaration of root.style.cssText.split(";")) {
    const name = declaration.slice(0, declaration.indexOf(":")).trim();
    if (BOOT_VAR_NAMES.has(name)) names.add(name);
  }
  return names;
}

export interface Frames {
  request(fn: () => void): number;
  cancel(id: number): void;
}

const WINDOW_FRAMES: Frames = {
  request: (fn) => window.requestAnimationFrame(fn),
  cancel: (id) => window.cancelAnimationFrame(id),
};
let pending: number[] = [];

/**
 * Applies a resolved appearance to <html>. Transitions are off for two frames so a theme change never fades in
 * steps (Orca applyDocumentTheme); a rapid second change cancels the first one's frames. Returns the variables set,
 * for the next call to remove what it no longer sets.
 */
export function applyAppearance(
  root: HTMLElement,
  resolved: ResolvedAppearance,
  previousVars: ReadonlySet<string>,
  frames: Frames = WINDOW_FRAMES,
): Set<string> {
  root.classList.add("theme-swap");
  for (const name of APPEARANCE_ATTRS) root.setAttribute(`data-${name}`, resolved.attrs[name]);
  for (const name of previousVars) if (!(name in resolved.vars)) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(resolved.vars)) root.style.setProperty(name, value);
  pending.forEach((id) => frames.cancel(id));
  pending = [];
  pending.push(
    frames.request(() => {
      pending.push(frames.request(() => root.classList.remove("theme-swap")));
    }),
  );
  return new Set(Object.keys(resolved.vars));
}

/** False in private mode or with a full quota: the next load paints the defaults first, then the app applies. */
export function writeBootCache(storage: Pick<Storage, "setItem">, cache: BootCache): boolean {
  try {
    storage.setItem(BOOT_KEY, JSON.stringify(cache));
    return true;
  } catch {
    reportClientIssue("boot_cache_refused");
    return false;
  }
}

/** The browser chrome follows the side bar colour (T3 syncBrowserChromeTheme). */
export function syncThemeColor(root: HTMLElement, doc: Document = document): void {
  const color = getComputedStyle(root).getPropertyValue("--bg-side").trim();
  const meta = doc.querySelector('meta[name="theme-color"]');
  if (meta && /^#[0-9a-f]{6}$/i.test(color)) meta.setAttribute("content", color);
}
