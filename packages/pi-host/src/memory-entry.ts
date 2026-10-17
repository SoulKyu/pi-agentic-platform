import type { SessionManager } from "@earendil-works/pi-coding-agent";

/** pi-mem0's entry name (its contract, not pap's: `src/agent-session.ts`, `PROFILE_NAME`, version 1). */
export const MEM0_PROFILE_ENTRY = "pi-web:agent-profile";
/** pap's own entry for a taint raised mid-run (owner m11): read by a pi-mem0 that checks it at capture time. */
export const MEMORY_TRUST_ENTRY = "pap:memory-trust";

export interface MemoryTrust {
  readonly profile: string; // an agent id, or "" (no valid profile: pi-mem0 fails closed)
  readonly trust: "trusted" | "untrusted";
  readonly memory?: Readonly<Record<string, unknown>>;
}

/** The newest version-1 profile entry already in the session, as pi-mem0 would read it. */
function newestProfileEntry(manager: SessionManager): unknown {
  let newest: unknown;
  for (const entry of manager.getEntries())
    if (entry.type === "custom" && entry.customType === MEM0_PROFILE_ENTRY) {
      const data = entry.data as { version?: unknown } | undefined;
      if (data?.version === 1) newest = data;
    }
  return newest;
}

/** Appended before extensions start (M11R142); only when it differs from the newest one, so a reopen adds nothing. */
export function appendMemoryTrust(manager: SessionManager, trust: MemoryTrust): void {
  const data = {
    version: 1,
    profile: trust.profile,
    trust: trust.trust,
    ...(trust.memory ? { memory: trust.memory } : {}),
  };
  if (JSON.stringify(newestProfileEntry(manager)) === JSON.stringify(data)) return;
  manager.appendCustomEntry(MEM0_PROFILE_ENTRY, data);
}

/** Stage 07 raised the taint during a run (M11R143). */
export function appendMidRunUntrusted(manager: SessionManager): void {
  manager.appendCustomEntry(MEMORY_TRUST_ENTRY, { version: 1, trust: "untrusted" });
}
