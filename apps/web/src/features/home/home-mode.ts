import { cancelsComposition } from "@pap/ui";
import { deviceStorage } from "../../stores/drafts.ts";

export const HOME_MODES = ["session", "lane", "fanout", "trigger"] as const;
export type HomeMode = (typeof HOME_MODES)[number];

/** The last mode chosen on this device (§3.1); not per account. */
export const MODE_KEY = "pap.home.mode.v1";

/** The last mode chosen here; Session when none was, when storage holds anything else, or when it refuses. */
export function readMode(): HomeMode {
  try {
    const raw = deviceStorage()?.getItem(MODE_KEY);
    return (HOME_MODES as readonly unknown[]).includes(raw) ? (raw as HomeMode) : "session";
  } catch {
    return "session";
  }
}

/** Remembers the choice for this device; storage that refuses leaves it holding for this page only. */
export function rememberMode(mode: HomeMode): void {
  try {
    deviceStorage()?.setItem(MODE_KEY, mode);
  } catch {
    // A convenience only: the composer keeps the mode in memory.
  }
}

interface LaunchKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly nativeEvent: { readonly isComposing: boolean; readonly keyCode?: number };
}

/**
 * §3.1 and PH6: Enter launches (Ctrl/⌘+Enter too), Shift+Enter adds a line. An input method's Enter never launches,
 * and on a phone, whose keyboard has no Shift, Enter is a new line and the button launches.
 */
export function isLaunchKey(event: LaunchKeyEvent, phone: boolean): boolean {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.altKey &&
    !phone &&
    !cancelsComposition(event.nativeEvent)
  );
}
