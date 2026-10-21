import { createHash } from "node:crypto";
import { type EgressHost, tryParseHostEntry } from "@pap/contracts";

/** What one command reached (M11R237): hosts and counts, never a path, header, body or byte of content. */
export interface CommandReport {
  hosts: EgressHost[];
  truncated: boolean;
  up: number;
  down: number;
}

export function createReport(maxHosts: number) {
  const seen = new Set<string>();
  const hosts: EgressHost[] = [];
  let truncated = false;
  let allowed = 0;
  let refused = 0;
  let up = 0;
  let down = 0;
  return {
    add(entry: EgressHost): void {
      if (entry.verdict === "allowed") allowed += 1;
      else refused += 1;
      const key = [entry.kind, entry.host, entry.port, entry.verdict, entry.reason ?? ""].join("|");
      if (seen.has(key)) return;
      if (hosts.length >= maxHosts) {
        truncated = true;
        return;
      }
      seen.add(key);
      hosts.push(entry);
    },
    count(direction: "up" | "down", bytes: number): void {
      if (direction === "up") up += bytes;
      else down += bytes;
    },
    total: (): number => up + down,
    counts: () => ({ allowed, refused }),
    snapshot: (): CommandReport => ({ hosts: [...hosts], truncated, up, down }),
  };
}

/**
 * The hosts for the one log line (W5-R54): distinct, at most `max`. A host is written as is only when it equals, character
 * for character, an entry the owner wrote (the list in force, a trusted source, a grant); any other, a wildcard match and a
 * refused host included, is a hash and its length, because an agent chose it and it may hold a secret.
 */
export function loggedHosts(
  report: CommandReport,
  scope: {
    readonly hosts: readonly string[] | null;
    readonly trustedSources: readonly string[];
    grants(): readonly string[];
  },
  max: number,
): string[] {
  const written = new Set([...(scope.hosts ?? []), ...scope.trustedSources, ...scope.grants()]);
  return [...new Set(report.hosts.map((entry) => entry.host))]
    .slice(0, max)
    .map((host) => hostLabel(host, written));
}

/** A host as it may be logged: as written when the owner wrote it, else a hash and its length (W5-R54). */
export const hostLabel = (host: string, written: ReadonlySet<string>): string =>
  written.has(host)
    ? host
    : `h:${createHash("sha256").update(host).digest("hex").slice(0, 12)} (len ${host.length})`;

/** What the owner wrote in an agent VM's host list: each entry as written, and the host part of an exact `host:port` or IP entry. */
export const writtenEntries = (entries: readonly string[]): Set<string> =>
  new Set(
    entries.flatMap((raw) => {
      const parsed = tryParseHostEntry(raw);
      return parsed && !parsed.wildcard ? [raw, parsed.host] : [raw];
    }),
  );
