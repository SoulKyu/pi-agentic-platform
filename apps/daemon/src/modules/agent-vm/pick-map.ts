/** One package entry of the profile build: the exact source `settings.json` spells and the entry the image wrote for it. */
export interface WrittenEntry {
  readonly source: string;
  readonly written: string;
}

/**
 * AVM-E42 I1: the guest narrows the image's list by the sources the image WROTE (the build rewrites them: an unpinned npm name
 * gets its installed version, a git URL becomes `git:host/path`, a local path becomes `local/<name>`). The picks the daemon holds are
 * the exact spellings, so each is mapped to its written entry; one the image did not write is returned in `missing` for the caller
 * to log, never dropped without a trace.
 */
export function imageEntriesOf(
  picks: readonly string[],
  written: readonly WrittenEntry[],
): { entries: string[]; missing: string[] } {
  const bySource = new Map(written.map((one) => [one.source, one.written]));
  const entries: string[] = [];
  const missing: string[] = [];
  for (const pick of picks) {
    const found = bySource.get(pick);
    if (found === undefined) missing.push(pick);
    else entries.push(found);
  }
  return { entries, missing };
}

/** The entries each agent's profile build wrote, kept for the launch (the build records them, the launch maps its picks through them). */
export function createImageEntries(logger: { warn(code: string, fields: Record<string, unknown>): void }) {
  const byAgent = new Map<string, readonly WrittenEntry[]>();
  return {
    record(agentId: string, written: readonly WrittenEntry[]): void {
      byAgent.set(agentId, written);
    },
    forget(agentId: string): void {
      byAgent.delete(agentId);
    },
    /** `null` stays `null` (every package). Without a recorded build the picks go on as they are, and that is logged. */
    toImage(agentId: string, sources: readonly string[] | null): string[] | null {
      if (sources === null) return null;
      const written = byAgent.get(agentId);
      if (written === undefined) {
        logger.warn("agent_pick_image_unknown", { agentId, picks: sources.length });
        return [...sources];
      }
      const mapped = imageEntriesOf(sources, written);
      if (mapped.missing.length > 0)
        logger.warn("agent_pick_not_in_image", { agentId, count: mapped.missing.length });
      return mapped.entries;
    },
  };
}
