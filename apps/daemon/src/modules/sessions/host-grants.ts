import { MAX_HOST_GRANTS, TrustedHost } from "@pap/contracts";
import { type Logger, silentLogger } from "../../kernel/logger.ts";

/** The hosts the owner allowed for the rest of an agent thread (owner a2, M11R210): daemon memory only, never stored. */
export interface HostGrants {
  /** Records a host for the session; a malformed host is ignored, and one past the 64th is refused with a `host_grant_limit` line (no host in it). */
  note(sessionId: string, host: string): void;
  has(sessionId: string, host: string): boolean;
  /** A copy of the session's hosts, in the order they were allowed. */
  of(sessionId: string): string[];
  /** The thread's session was archived (or its agent deleted): its hosts end. */
  drop(sessionId: string): void;
}

export function createHostGrants(logger: Logger = silentLogger): HostGrants {
  // One entry per session that was granted a host and not archived since: bounded by the owner's threads.
  const granted = new Map<string, Set<string>>();
  return {
    note(sessionId, host) {
      if (!TrustedHost.safeParse(host).success) return;
      const hosts = granted.get(sessionId) ?? new Set<string>();
      if (hosts.size >= MAX_HOST_GRANTS && !hosts.has(host)) {
        logger.warn("host_grant_limit", { sessionId, limit: MAX_HOST_GRANTS });
        return;
      }
      hosts.add(host);
      granted.set(sessionId, hosts);
    },
    has: (sessionId, host) => granted.get(sessionId)?.has(host) ?? false,
    of: (sessionId) => [...(granted.get(sessionId) ?? [])],
    drop: (sessionId) => void granted.delete(sessionId),
  };
}
