import { randomBytes } from "node:crypto";
import { fenceText, PLACEHOLDER } from "@pap/contracts";

export const FENCE_SOURCES = [
  "webhook",
  "alertmanager",
  "grafana",
  "feed",
  "precheck",
  "manual",
  "handoff",
  "delegation",
  "reminder",
] as const;
export type FenceSource = (typeof FENCE_SOURCES)[number];
/** The `tasks.prompt` CHECK: a rendered prompt longer than this is a journal `error` `prompt_too_large` (RT-24). */
export const RENDERED_PROMPT_MAX = 131_072;

/** One id per fenced block, 12 hex: a closing tag written inside the text cannot carry it. */
export const newFenceId = (): string => randomBytes(6).toString("hex");

// eslint-disable-next-line no-control-regex -- the control characters are what this pattern removes
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]|\p{Cf}/gu;

/**
 * pap's one fence format (contracts `fenceText`, agreement 6). Every fenced input passes here, so this is the one place
 * that drops what a reader cannot see: format characters (tag characters U+E0000-E007F, bidi, zero-width) and the C0/C1
 * controls except newline and tab.
 */
export const fence = (text: string, source: FenceSource, id: string): string =>
  fenceText(text.replace(HIDDEN, ""), source, id);

export interface PromptValues {
  readonly payload: { readonly text: string; readonly source: FenceSource } | null;
  readonly precheck: string | null;
  readonly trigger: string;
  readonly firedAt: string;
}

/**
 * One pass over the template: text put in place of a placeholder is never read again (a payload holding
 * `{{precheck}}` stays text). A payload the template does not place is added at the end, fenced: it is always sent
 * fenced, never bare. `fenced` says whether outside text is in the prompt (the run then starts tainted).
 */
export function renderPrompt(
  template: string,
  values: PromptValues,
  newId: () => string = newFenceId,
): { text: string; fenced: boolean } {
  let fenced = false;
  let placedPayload = false;
  const text = template.replace(PLACEHOLDER, (whole, name: string) => {
    switch (name) {
      case "payload":
        if (values.payload === null) return "";
        placedPayload = true;
        fenced = true;
        return fence(values.payload.text, values.payload.source, newId());
      case "precheck":
        if (values.precheck === null) return "";
        fenced = true;
        return fence(values.precheck, "precheck", newId());
      case "trigger":
        return values.trigger;
      case "firedAt":
        return values.firedAt;
      default:
        return whole;
    }
  });
  if (values.payload !== null && !placedPayload) {
    fenced = true;
    return { text: `${text}\n\n${fence(values.payload.text, values.payload.source, newId())}`, fenced };
  }
  return { text, fenced };
}
