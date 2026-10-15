import { escapeHidden } from "./escape-hidden.ts";

/** The longest owner-chosen name (a trigger's) that is shown whole. */
export const NAME_CHARS = 80;

/** An owner-chosen name as visible text: hidden characters written out, cut at `NAME_CHARS` characters. */
export function visibleName(text: string): string {
  const points = Array.from(escapeHidden(text));
  return points.length > NAME_CHARS ? `${points.slice(0, NAME_CHARS).join("")}…` : points.join("");
}
