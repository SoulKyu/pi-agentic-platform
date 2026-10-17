import { type EgressHost, type EgressReport, type EgressReason, TrustedHost } from "@pap/contracts";

/** The most hosts one line names; the rest is counted. */
const MAX_NAMED = 8;
export const NO_PROXY_LINE =
  "[pap] The egress proxy was not available for this command; it ran without network.";

const REASONS: Readonly<Record<EgressReason, string>> = {
  not_listed: "not on this agent's host list",
  port: "only ports 80 and 443 are open",
  ip_literal: "IP addresses are not allowed; use a host name",
  bad_target: "not a valid host name",
  blocked_ip: "resolves to a private or reserved address",
  dns_failed: "the name could not be resolved",
  bad_request: "only absolute http:// URLs and CONNECT host:443 are accepted",
  scheme: "only http:// URLs are proxied; use CONNECT host:443 for https",
  limit: "too many connections",
};

/** Refused hosts, once each, in the order the proxy saw them. A name that is not a plain host is dropped: this text is the model's to read. */
function refusedHosts(report: EgressReport): EgressHost[] {
  const seen = new Set<string>();
  return report.hosts.filter((entry) => {
    if (entry.verdict !== "refused" || seen.has(entry.host) || !TrustedHost.safeParse(entry.host).success)
      return false;
    seen.add(entry.host);
    return true;
  });
}

/**
 * M11R238: the line after the command's own output when the proxy refused hosts (so a fenced result fences it too). An
 * isolated task (`view: "system"`) cannot ask for hosts. Null when nothing was refused.
 */
export function refusedLine(report: EgressReport | null, view: "host" | "system"): string | null {
  const refused = report ? refusedHosts(report) : [];
  if (refused.length === 0) return null;
  const named = refused
    .slice(0, MAX_NAMED)
    .map((entry) => `${entry.host} (${REASONS[entry.reason ?? "not_listed"]})`);
  const more = refused.length - named.length;
  const list = more > 0 ? [...named, `and ${more} more`] : named;
  const asking = refused.find((entry) => (entry.reason ?? "not_listed") === "not_listed");
  const advice =
    view === "system"
      ? " An isolated task cannot ask for more hosts."
      : asking
        ? ` In this thread, ask the owner with network_request {"host": "${asking.host}"}.`
        : "";
  return `[pap] The egress proxy refused: ${list.join(", ")}.${advice}`;
}
