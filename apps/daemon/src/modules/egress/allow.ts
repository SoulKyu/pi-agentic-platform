import { isIP } from "node:net";
import { type EgressReason, lastLabelStartsWithDigit } from "@pap/contracts";

/** What a command's connections are judged against (owner a1, a2). */
export interface EgressScope {
  readonly ownerId: string;
  readonly agentId: string;
  /** Null for a precheck: no grants. */
  readonly sessionId: string | null;
  /** The worker's start-time list (W5-R26): the agent's, else the owner's, else empty. Null (any public host) is for tests only: no production scope carries it (C 5.3). */
  readonly hosts: readonly string[] | null;
  readonly trustedSources: readonly string[];
  /** Live: the thread's grants now (W5-R35); [] for tasks, children, prechecks. */
  grants(): readonly string[];
}

/** An exact entry, or `*.` and a parent (subdomains only): the host list's semantics (M5R21). */
const hostMatches = (host: string, list: readonly string[]): boolean =>
  list.some((entry) =>
    entry.startsWith("*.") ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1 : host === entry,
  );

/** The effective allowlist, read at each connection. */
export const allowed = (scope: EgressScope, host: string): boolean =>
  scope.hosts === null ||
  hostMatches(host, scope.hosts) ||
  scope.trustedSources.includes(host) ||
  scope.grants().includes(host);

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A target host as the proxy judges it: lower-cased, one final dot dropped, ASCII labels only (IDNs arrive as `xn--`),
 * at least two labels. An IP literal in any spelling (a last label starting with a digit, as `127.1`, `127.0x1` or `2130706433`: no top-level domain does) is
 * its own reason.
 */
export function normalizeHost(raw: string): { host: string } | { reason: EgressReason } {
  const lower = raw.toLowerCase().replace(/\.$/, "");
  const bare = lower.replace(/^\[|\]$/g, "");
  const labels = lower.split(".");
  if (isIP(bare) !== 0 || lastLabelStartsWithDigit(lower)) return { reason: "ip_literal" };
  if (lower.length > 253 || labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
    return { reason: "bad_target" };
  }
  return { host: lower };
}
