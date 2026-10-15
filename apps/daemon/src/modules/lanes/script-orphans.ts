import { readFileSync } from "node:fs";
import type { Logger } from "../../kernel/logger.ts";
import { parseProcStat } from "../../kernel/pty/kill.ts";
import type { ScriptStore } from "./script-store.ts";

/** What /proc says about this boot and about a process; sync reads of two tiny files. */
export interface ProcProbe {
  bootId(): string | null;
  /** Field 22 of `/proc/<pid>/stat`: the process's start, in ticks since boot. */
  startOf(pid: number): string | null;
}

export const LINUX_PROBE: ProcProbe = {
  bootId() {
    try {
      return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
    } catch {
      return null;
    }
  },
  startOf(pid) {
    try {
      return parseProcStat(pid, readFileSync(`/proc/${pid}/stat`, "utf8"))?.start ?? null;
    } catch {
      return null;
    }
  },
};

/** `<boot id>:<start time>`, or null when /proc cannot say (the row then never matches a group at boot). */
export function procTag(probe: ProcProbe, pid: number): string | null {
  const boot = probe.bootId();
  const start = probe.startOf(pid);
  return boot !== null && start !== null ? `${boot}:${start}` : null;
}

export interface OrphanDeps {
  readonly store: ScriptStore;
  readonly probe: ProcProbe;
  readonly logger: Logger;
  /** SIGKILL to a process group; false when there is none. */
  killGroup(pgid: number): boolean;
  onChange(laneId: string): void;
}

/**
 * At boot, before the server listens (M9R116): a script group an earlier daemon of this boot left behind gets SIGKILL
 * when its start time is the one stored (a recycled pid has another). A scope, if any, was swept with the other
 * terminal scopes. The row turns `interrupted` either way and nothing is spawned. Never throws.
 */
export function recoverOrphans(deps: OrphanDeps): void {
  const boot = deps.probe.bootId();
  let rows: ReturnType<ScriptStore["leftovers"]>;
  try {
    rows = deps.store.leftovers();
  } catch (error) {
    return deps.logger.error("lane_script_recover_failed", { err: error });
  }
  for (const row of rows) {
    try {
      const at = row.proc === null ? -1 : row.proc.indexOf(":");
      if (row.pgid !== null && row.proc !== null && at > 0 && boot !== null) {
        const sameBoot = row.proc.slice(0, at) === boot;
        const sameStart = row.proc.slice(at + 1) === deps.probe.startOf(row.pgid);
        if (sameBoot && sameStart) deps.killGroup(row.pgid);
      }
      deps.store.interrupt(row.laneId);
      deps.onChange(row.laneId);
    } catch (error) {
      deps.logger.error("lane_script_recover_failed", { laneId: row.laneId, err: error });
    }
  }
}
