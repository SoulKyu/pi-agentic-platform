import { openSync, readdirSync, readlinkSync } from "node:fs";
import type { StdioOptions } from "node:child_process";

export interface FdMaskTable {
  readdir(path: string): string[];
  readlink(path: string): string;
  /** An fd on `/dev/null`, opened close-on-exec. */
  openNull(): number;
}

const real: FdMaskTable = {
  readdir: (path) => readdirSync(path),
  readlink: (path) => readlinkSync(path),
  openNull: () => openSync("/dev/null", "r+"),
};

let nullFd: number | null = null;

/** Descriptors from 3 up that lead to a PTY master (`/dev/ptmx`). A slave is not a master and is not masked. */
function masterFds(table: FdMaskTable): number[] {
  let names: string[];
  try {
    names = table.readdir("/proc/self/fd");
  } catch {
    return [];
  }
  const masters: number[] = [];
  for (const name of names) {
    const fd = Number(name);
    if (!Number.isInteger(fd) || fd < 3) continue;
    try {
      const link = table.readlink(`/proc/self/fd/${name}`);
      // Some containers expose the master as /dev/pts/ptmx: take any pty node, as the worker's closer does.
      if (link === "/dev/ptmx" || link.startsWith("/dev/pts/")) masters.push(fd);
    } catch {
      // closed between the listing and the read
    }
  }
  return masters;
}

/**
 * node-pty leaves every terminal's master without close-on-exec, so a child spawned afterwards holds it (MC29, MC38). The
 * returned `stdio` maps each master's number to `/dev/null` in the child (libuv dup2s over it). It must be DENSE: Node
 * compacts holes, so every gap is `"ignore"`. The list is read in the same tick as the spawn, so no master opens in
 * between. Without /proc (not Linux) or without a master, `base` is returned unchanged.
 */
export function maskedStdio(
  base: readonly ["pipe", "pipe", "pipe"],
  table: FdMaskTable = real,
): StdioOptions {
  const masters = masterFds(table);
  if (masters.length === 0) return [...base];
  nullFd ??= table.openNull();
  const stdio: Array<string | number> = [...base];
  const highest = Math.max(...masters);
  for (let fd = 3; fd <= highest; fd++) stdio.push(masters.includes(fd) ? nullFd : "ignore");
  return stdio as StdioOptions;
}
