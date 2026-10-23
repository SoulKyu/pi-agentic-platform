import { cleansContent, type EgressReport } from "@pap/contracts";

/** A networked command taints unless the proxy saw only CONNECT 443 to trusted sources (or nothing). No report, a cut one: taints. */
export function commandTaints(report: EgressReport | null | undefined, trusted: readonly string[]): boolean {
  if (report === null || report === undefined || report.truncated) return true;
  return report.hosts.some(
    (entry) => entry.verdict === "allowed" && !cleansContent(entry.kind, entry.port, entry.host, trusted),
  );
}

/** The stage 07 reason of a networked result with no report: it taints, and the row says why. */
export const NO_REPORT_REASON = "egress: no report";

/** Why a command that does not taint passed stage 07: it reached a trusted source only, or nothing pap let through. */
export const cleanReason = (report: EgressReport): string =>
  report.hosts.some((entry) => entry.verdict === "allowed")
    ? "egress: trusted sources only"
    : "egress: no network used";

/** What the stage 07 row of a networked result says, and whether it taints: one decision for the extension and its tests. */
export function egressVerdict(
  report: EgressReport | null | undefined,
  trusted: readonly string[],
): { readonly taints: boolean; readonly reason: string } {
  if (report === null || report === undefined) return { taints: true, reason: NO_REPORT_REASON };
  if (!commandTaints(report, trusted)) return { taints: false, reason: cleanReason(report) };
  return { taints: true, reason: report.truncated ? "egress: report cut" : "egress: untrusted host reached" };
}
