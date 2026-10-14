import { closeSync, readdirSync, readlinkSync } from "node:fs";

export interface FdTable {
  readdir(path: string): string[];
  readlink(path: string): string;
  close(fd: number): void;
  log(line: string): void;
}

const real: FdTable = {
  readdir: (path) => readdirSync(path),
  readlink: (path) => readlinkSync(path),
  close: (fd) => closeSync(fd),
  log: (line) => void process.stderr.write(`${line}\n`),
};

const isPty = (link: string): boolean => link === "/dev/ptmx" || link.startsWith("/dev/pts/");

/**
 * MC29: node-pty leaves the master of every terminal without close-on-exec, so the daemon's children inherit it and agent
 * code could type into the owner's shell. Closes each inherited descriptor from 3 up that leads to a pty; the IPC channel
 * is a socket and never matches. Without /proc it does nothing. Returns how many it closed.
 */
export function closeInheritedPtyFds(table: FdTable = real): number {
  let names: string[];
  try {
    names = table.readdir("/proc/self/fd");
  } catch {
    table.log("pi-host: pty descriptors not checked: /proc/self/fd is unreadable");
    return 0;
  }
  let closed = 0;
  let failed = 0;
  for (const name of names) {
    const fd = Number(name);
    if (!Number.isInteger(fd) || fd < 3) continue;
    let link: string;
    try {
      link = table.readlink(`/proc/self/fd/${name}`);
    } catch {
      // Already gone (readdir's own descriptor): nothing to close.
      continue;
    }
    if (!isPty(link)) continue;
    try {
      table.close(fd);
      closed++;
    } catch {
      failed++;
    }
  }
  if (closed > 0) table.log(`pi-host: closed ${closed} inherited pty descriptor(s)`);
  if (failed > 0) table.log(`pi-host: could not close ${failed} inherited pty descriptor(s)`);
  return closed;
}
