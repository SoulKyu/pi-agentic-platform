import type { DryRunResult, TrustStatus } from "@pap/contracts";
import { formatCost } from "@pap/ui";
import { t, type MessageKey } from "../../i18n/index.ts";
import { escapeHiddenKeepLines } from "../../lib/escape-hidden.ts";

export type PromptPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "fence"; readonly source: string; readonly text: string };

// pap's one fence (contracts `fenceText`): the source is made safe for an attribute, the id is 12 random hex.
const OPEN = /<untrusted source="([A-Za-z0-9_.-]{1,64})" id="([0-9a-f]{12})">\n/g;

/**
 * The rendered prompt as its trusted text and its fenced parts. A fence ends only at the closing tag that carries its
 * own id, so text inside it cannot end it; a prompt cut before its closing tag leaves the rest inside the fence.
 */
export function splitPrompt(prompt: string): PromptPart[] {
  const parts: PromptPart[] = [];
  let from = 0;
  for (;;) {
    OPEN.lastIndex = from;
    const open = OPEN.exec(prompt);
    if (open === null) break;
    const [tag, source = "", id = ""] = open;
    const start = open.index + tag.length;
    const end = prompt.indexOf(`\n</untrusted id="${id}">`, start);
    if (open.index > from) parts.push({ kind: "text", text: prompt.slice(from, open.index) });
    parts.push({ kind: "fence", source, text: prompt.slice(start, end === -1 ? prompt.length : end) });
    if (end === -1) return parts;
    from = end + `\n</untrusted id="${id}">`.length;
  }
  if (from < prompt.length) parts.push({ kind: "text", text: prompt.slice(from) });
  return parts;
}

/** Untrusted text on screen: hidden characters written out, lines kept, cut at a cap until the person asks for the rest. */
export const SHOWN_CAP = { lines: 12, chars: 2000 } as const;

export function capped(
  text: string,
  expanded: boolean,
): { readonly shown: string; readonly clipped: boolean } {
  const visible = escapeHiddenKeepLines(text);
  const lines = visible.split("\n");
  let end = visible.length;
  if (lines.length > SHOWN_CAP.lines) end = lines.slice(0, SHOWN_CAP.lines).join("\n").length;
  if (end > SHOWN_CAP.chars) end = SHOWN_CAP.chars;
  const last = visible.charCodeAt(end - 1);
  if (end < visible.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
  if (expanded || end >= visible.length) return { shown: visible, clipped: end < visible.length };
  return { shown: `${visible.slice(0, end)}…`, clipped: true };
}

export function verdictText(result: DryRunResult): string {
  if (result.verdict === "fire") return t("automation.dry.verdictFire");
  const reason = result.reasons.map((one) => t(`automation.dry.reason.${one}`)).join(", ");
  return t("automation.dry.verdictSkip", { reason });
}

const seconds = (ms: number): string => (ms / 1000).toFixed(1);

/** The precheck line, and its output (untrusted: shown fenced) when it ran. */
export function precheckLine(
  precheck: DryRunResult["precheck"],
): { line: string; output: string | null } | null {
  if (precheck === null) return null;
  if (typeof precheck === "string") return { line: t(`automation.dry.notRun.${precheck}`), output: null };
  const line =
    precheck.verdict === "error"
      ? t("automation.dry.precheckFailed", { seconds: seconds(precheck.durationMs) })
      : t("automation.dry.precheckExit", {
          code: precheck.exitCode ?? "?",
          seconds: seconds(precheck.durationMs),
        });
  return { line, output: precheck.output === "" ? null : precheck.output };
}

export function budgetLine(budget: DryRunResult["budget"]): string {
  const spent = formatCost(budget.spentUsd);
  return budget.budgetUsd === null
    ? t("automation.dry.budgetNone", { spent })
    : t("automation.dry.budget", { spent, budget: formatCost(budget.budgetUsd) });
}

/** M10R64's profile line; the mode note under it repeats the editor's (RT-13). */
export function profileLine(profile: DryRunResult["profile"]): string {
  return t("automation.dry.profileLine", {
    preset: t(`automation.dry.preset.${profile.preset}`),
    mode: t(`automation.editor.mode.${profile.mode}`),
    taint: t(profile.tainted ? "automation.dry.tainted" : "automation.dry.clean"),
  });
}

/** Board 11's "confiance ✓" comes from Pi's decision for the folder (`trust.status`). */
export function trustKey(status: TrustStatus): MessageKey {
  if (status.decision === true) return "automation.dry.trusted";
  if (status.decision === false) return "automation.dry.untrusted";
  return status.requiresTrust ? "automation.dry.undecided" : "automation.dry.nothingToTrust";
}
