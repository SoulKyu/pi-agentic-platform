import { TOOL_PRESETS, type ToolPreset } from "@pap/contracts";
import { deviceStorage } from "../../stores/drafts.ts";

/** The order the picker lists the presets in. */
export const PRESET_ORDER: readonly ToolPreset[] = [
  "default",
  "full",
  "read-only",
  "none",
  "chat",
  "configured",
];

export const LAST_PRESET_KEY = "pap.newSession.preset";

/** Switching into or out of Chat restarts a live worker (ADR 0028): the person is asked first. */
export const crossesChat = (from: ToolPreset | null, to: ToolPreset): boolean =>
  from !== null && (from === "chat") !== (to === "chat");

/** The preset the new-session form starts with: the last explicit choice on this browser, else Pi's own (`configured`). */
export function lastPreset(): ToolPreset {
  try {
    const raw = deviceStorage()?.getItem(LAST_PRESET_KEY);
    return (TOOL_PRESETS as readonly unknown[]).includes(raw) ? (raw as ToolPreset) : "configured";
  } catch {
    return "configured";
  }
}

/** Remembers an explicit choice; storage that refuses leaves it holding for this page only. */
export function rememberPreset(preset: ToolPreset): void {
  try {
    deviceStorage()?.setItem(LAST_PRESET_KEY, preset);
  } catch {
    // A convenience only: the form keeps the choice in memory.
  }
}
