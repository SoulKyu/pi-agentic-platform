import { lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { digHolesArgv } from "./argv.ts";
import type { Logger } from "./log.ts";
import type { Exec } from "./ops.ts";

const DIG_HOLES_TIMEOUT_MS = 10 * 60_000;

/** Bytes the host really holds for a regular file (stat blocks x 512), or null when it is not one. */
function allocatedBytes(file: string): number | null {
  try {
    const stat = lstatSync(file);
    return stat.isFile() ? stat.blocks * 512 : null;
  } catch {
    return null;
  }
}

/** True when some process has `file` open (a `/proc/<pid>/fd` link names it). Fails closed: an unreadable /proc counts as held. */
export function procHoldsFile(file: string): boolean {
  let real: string;
  let pids: string[];
  try {
    real = realpathSync(file);
    pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return true;
  }
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      // Exited meanwhile, or (only when not root) owned by someone else: pap-vmd runs as root, which can read every table.
      continue;
    }
    for (const fd of fds) {
      try {
        if (readlinkSync(`/proc/${pid}/fd/${fd}`) === real) return true;
      } catch {
        // The descriptor closed between the listing and the read.
      }
    }
  }
  return false;
}

/**
 * Gives a stopped box's disk back to the host: `fallocate --dig-holes` turns the zero blocks of a disk Cloud Hypervisor once
 * pre-allocated (Kata 4.2) into holes. The caller proves no VM holds the file. A failure is logged with a fixed word, never thrown.
 */
export async function reclaimDisk(
  exec: Exec,
  log: Logger,
  file: string,
  holdsFile: (file: string) => boolean = procHoldsFile,
): Promise<void> {
  const before = allocatedBytes(file);
  if (before === null) return;
  if (holdsFile(file)) {
    log.info("vmd_disk_reclaim_skipped", { reason: "file_held" });
    return;
  }
  const result = await exec(digHolesArgv(file), { timeoutMs: DIG_HOLES_TIMEOUT_MS });
  const after = allocatedBytes(file);
  if (result.code !== 0 || after === null) {
    log.info("vmd_disk_reclaim_failed", { reason: result.code === -1 ? "timeout_or_spawn" : "exec" });
    return;
  }
  log.info("vmd_disk_reclaimed", { before, after, reclaimed: Math.max(0, before - after) });
}
