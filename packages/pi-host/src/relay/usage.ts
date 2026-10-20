import { RELAY_USAGE_MAX_AGENTS, type RelayReport as RelayReportSchema } from "@pap/contracts";
import type { z } from "zod";

type RelayReport = z.infer<typeof RelayReportSchema>;

/** The slice of a clock the relay needs (pi-host has no kernel `Clock`): a test steps it by hand. */
export interface RelayClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export type RelayUsage = ReturnType<typeof createUsage>;
export const USAGE_REPORT_MS = 60_000;

interface Counts {
  requests: number;
  refused: number;
  bytesIn: number;
  bytesOut: number;
}
const MAX_AGENTS = 4096;

/**
 * Attribution (RT-17, R13): requests, refusals and bytes per agent, reported every 60 s as `relay_usage` and reset after
 * each report. A report holds at most `RELAY_USAGE_MAX_AGENTS` agents: a longer list goes out as several. Nothing is
 * reported for a quiet minute.
 */
export function createUsage(clock: RelayClock, report: (report: RelayReport) => void) {
  const counts = new Map<string, Counts>();
  let timer: unknown = null;
  const of = (agentId: string): Counts | null => {
    let entry = counts.get(agentId);
    if (entry === undefined) {
      if (counts.size >= MAX_AGENTS) return null;
      entry = { requests: 0, refused: 0, bytesIn: 0, bytesOut: 0 };
      counts.set(agentId, entry);
    }
    return entry;
  };
  function flush(): void {
    const all = [...counts].map(([agentId, entry]) => ({ agentId, ...entry }));
    counts.clear();
    for (let at = 0; at < all.length; at += RELAY_USAGE_MAX_AGENTS)
      report({ type: "relay_usage", agents: all.slice(at, at + RELAY_USAGE_MAX_AGENTS) });
  }
  function schedule(): void {
    timer = clock.setTimeout(() => {
      flush();
      schedule();
    }, USAGE_REPORT_MS);
  }
  return {
    start(): void {
      if (timer === null) schedule();
    },
    stop(): void {
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    },
    request(agentId: string, size: { bytesIn: number }): void {
      const entry = of(agentId);
      if (entry === null) return;
      entry.requests += 1;
      entry.bytesIn += size.bytesIn;
    },
    finished(agentId: string, size: { bytesOut: number }): void {
      const entry = of(agentId);
      if (entry !== null) entry.bytesOut += size.bytesOut;
    },
    refused(agentId: string): void {
      const entry = of(agentId);
      if (entry !== null) entry.refused += 1;
    },
  };
}
