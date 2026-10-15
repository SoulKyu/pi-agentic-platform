import { AUTOMATION_LIMITS, INVISIBLE, LANE_LIMITS } from "@pap/contracts";
import type { NewLanePrefill } from "../../stores/new-lane-request.ts";
import type { TriggerPrefill } from "../../stores/trigger-prefill.ts";

const HIDDEN = new RegExp(INVISIBLE.source, "gu");

/** A line as a title: a tab is a space, every other hidden character (bidi, zero-width, controls) goes, ends trimmed. */
const visible = (line: string): string => line.replace(HIDDEN, (char) => (char === "\t" ? " " : "")).trim();

/** The first line that shows something, cleaned, and the lines after it, trimmed; both empty for a blank text. */
export function splitLaunchText(text: string): { readonly first: string; readonly rest: string } {
  const lines = text.split(/\r\n|[\n\r\u2028\u2029]/u);
  const at = lines.findIndex((line) => visible(line) !== "");
  if (at === -1) return { first: "", rest: "" };
  return {
    first: visible(lines[at] ?? ""),
    rest: lines
      .slice(at + 1)
      .join("\n")
      .trim(),
  };
}

/** At most `points` code points and `units` UTF-16 units, never half of a surrogate pair, no trailing space. */
export function clipTitle(title: string, points: number, units: number): string {
  let clipped = "";
  let count = 0;
  for (const char of title) {
    if (count === points || clipped.length + char.length > units) break;
    clipped += char;
    count += 1;
  }
  return clipped.trimEnd();
}

/**
 * Lane and Fan-out (§3.1, PH7): the title is the first line; the description is the lines after it, or the whole text
 * when there are none (a lane needs a description; its first prompt is `# title` then the description).
 */
export function laneLaunch(text: string, projectRoot: string, fanout: boolean): NewLanePrefill {
  const { first, rest } = splitLaunchText(text);
  const title = clipTitle(first, LANE_LIMITS.title, LANE_LIMITS.title);
  // A clipped first line keeps its tail in the description: nothing the person typed is lost.
  const description = title === first ? rest : `${first}\n${rest}`.trim();
  return {
    projectRoot,
    title,
    text: description === "" ? text.trim() : description,
    models: fanout ? [null, null] : [null],
  };
}

/** Trigger (§3.1): the name is the first line, clipped; the prompt is the whole text. */
export function triggerLaunch(text: string): TriggerPrefill {
  return {
    name: clipTitle(
      splitLaunchText(text).first,
      AUTOMATION_LIMITS.nameChars,
      AUTOMATION_LIMITS.nameChars * 4,
    ),
    prompt: text.trim(),
  };
}
