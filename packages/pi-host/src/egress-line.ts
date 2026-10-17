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

/** Who reads the line, and so what it can say about asking: a thread asks the owner, an isolated task and a child cannot. */
export type RefusalAdvice = "thread" | "isolated" | "child";

/**
 * The advice follows the session's kind, not the mount view (Task 29b, carry 2): a child of an agent thread has the thread's
 * profile and mount but none of its platform tools, so only the presence of `network.request` makes it a thread.
 */
export function refusalAdviceOf(profile: string | undefined, ops: readonly string[]): RefusalAdvice {
  if (profile === "isolated-task") return "isolated";
  return profile === "agent-thread" && ops.includes("network.request") ? "thread" : "child";
}

/**
 * M11R238: the line after the command's own output when the proxy refused hosts (so a fenced result fences it too). Only a
 * thread can ask for more hosts. Null when nothing was refused.
 */
export function refusedLine(report: EgressReport | null, advice: RefusalAdvice): string | null {
  const refused = report ? refusedHosts(report) : [];
  if (refused.length === 0) return null;
  const named = refused
    .slice(0, MAX_NAMED)
    .map((entry) => `${entry.host} (${REASONS[entry.reason ?? "not_listed"]})`);
  const more = refused.length - named.length;
  const list = more > 0 ? [...named, `and ${more} more`] : named;
  const asking = refused.find((entry) => (entry.reason ?? "not_listed") === "not_listed");
  const sentence =
    advice === "isolated"
      ? " An isolated task cannot ask for more hosts."
      : advice === "child"
        ? " This session cannot ask for more hosts; say in your answer which host you need."
        : asking
          ? ` In this thread, ask the owner with network_request {"host": "${asking.host}"}.`
          : "";
  return `[pap] The egress proxy refused: ${list.join(", ")}.${sentence}`;
}
