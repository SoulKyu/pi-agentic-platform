import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
} from "node:fs";
import path from "node:path";
import { sparseCopyArgv } from "./argv.ts";
import type { Logger } from "./log.ts";
import type { Exec } from "./ops.ts";

const COPY_TIMEOUT_MS = 10 * 60_000;

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

const ROOM_MARGIN_BYTES = 256 * 1024 * 1024;

function availableBytes(folder: string): number {
  const stat = statfsSync(folder);
  return stat.bavail * stat.bsize;
}

function fsyncPath(target: string): void {
  const fd = openSync(target, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Gives a stopped box's disk back to the host by a sparse copy: a disk Cloud Hypervisor pre-allocated (Kata 4.2) holds unwritten
 * extents, which `fallocate --dig-holes` takes for holes, while `cp --sparse=always` reads them as zeros and leaves none. The copy
 * is made beside the disk, checked, synced and renamed over it; the original is never touched before that. The caller proves no
 * VM holds the file. A failure is logged with a fixed word, never thrown.
 */
export async function reclaimDisk(
  exec: Exec,
  log: Logger,
  file: string,
  holdsFile: (file: string) => boolean = procHoldsFile,
  freeBytes: (folder: string) => number = availableBytes,
): Promise<void> {
  const before = allocatedBytes(file);
  if (before === null) return;
  if (holdsFile(file)) {
    log.info("vmd_disk_reclaim_skipped", { reason: "file_held" });
    return;
  }
  const temp = `${file}.reclaim`;
  const fail = (reason: string): void => {
    rmSync(temp, { force: true });
    log.info("vmd_disk_reclaim_failed", { reason });
  };
  try {
    rmSync(temp, { force: true });
    if (freeBytes(path.dirname(file)) < before + ROOM_MARGIN_BYTES) {
      log.info("vmd_disk_reclaim_skipped", { reason: "no_room" });
      return;
    }
    const result = await exec(sparseCopyArgv(file, temp), { timeoutMs: COPY_TIMEOUT_MS });
    if (result.code !== 0) return fail(result.code === -1 ? "timeout_or_spawn" : "exec");
    if (lstatSync(temp).size !== lstatSync(file).size) return fail("size_mismatch");
    fsyncPath(temp);
    renameSync(temp, file);
    fsyncPath(path.dirname(file));
  } catch {
    return fail("io");
  }
  const after = allocatedBytes(file);
  log.info("vmd_disk_reclaimed", {
    before,
    after: after ?? before,
    reclaimed: Math.max(0, before - (after ?? before)),
  });
}
