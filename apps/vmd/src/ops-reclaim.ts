import { lstatSync } from "node:fs";
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

/**
 * Gives a stopped box's disk back to the host: `fallocate --dig-holes` turns the zero blocks of a disk Cloud Hypervisor once
 * pre-allocated (Kata 4.2) into holes. The caller proves no VM holds the file. A failure is logged with a fixed word, never thrown.
 */
export async function reclaimDisk(exec: Exec, log: Logger, file: string): Promise<void> {
  const before = allocatedBytes(file);
  if (before === null) return;
  const result = await exec(digHolesArgv(file), { timeoutMs: DIG_HOLES_TIMEOUT_MS });
  const after = allocatedBytes(file);
  if (result.code !== 0 || after === null) {
    log.info("vmd_disk_reclaim_failed", { reason: result.code === -1 ? "timeout_or_spawn" : "exec" });
    return;
  }
  log.info("vmd_disk_reclaimed", { before, after, reclaimed: Math.max(0, before - after) });
}
