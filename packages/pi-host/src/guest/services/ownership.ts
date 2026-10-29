import { readdirSync, readFileSync, readlinkSync } from "node:fs";

/** What the check reads of `/proc`; a test gives a fake, the guest `procReader()`. Every read of a gone process is null or empty. */
export interface ProcReader {
  pids(): readonly number[];
  /** `/proc/<pid>/stat`. */
  stat(pid: number): string | null;
  /** The targets of the `/proc/<pid>/fd/*` links. */
  fdLinks(pid: number): readonly string[];
  /** `/proc/<pid>/net/tcp` and `tcp6`: the tables of that process's network namespace. */
  tcpTables(pid: number): { readonly v4: string; readonly v6: string } | null;
}

export type Ownership =
  | {
      readonly owned: true;
      readonly host: "127.0.0.1" | "::1";
      readonly nsPid: number;
      /** Field 22 of `nsPid`'s stat, read in the same check: a pid reused later never has it (red team M8). */
      readonly nsStart: string;
    }
  | { readonly owned: false; readonly reason: "gone" | "not_listening" | "port_not_owned" };

/**
 * Where the service's network namespace is read: `child` for a bwrap launch (the outer bwrap stays in the guest's
 * namespaces, the sandbox is its descendant), `root` for the process backend's plain launch (tests only).
 */
export type NetnsFrom = "child" | "root";

/** The ppid of a `/proc/<pid>/stat` line: the comm field is in parentheses and may itself hold spaces and parentheses. */
export function ppidOf(stat: string): number | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const ppid = Number(stat.slice(close + 2).split(" ")[1]);
  return Number.isSafeInteger(ppid) && ppid >= 0 ? ppid : null;
}

/** Field 22 of a `/proc/<pid>/stat` line (the start time in clock ticks since boot), after the parenthesised comm. */
export function startTimeOf(stat: string): string | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const start = stat.slice(close + 2).split(" ")[19];
  return start !== undefined && /^\d+$/.test(start) ? start : null;
}

/** The root and every descendant, from one pass over `/proc`. */
export function treeOf(root: number, proc: ProcReader): number[] {
  const children = new Map<number, number[]>();
  for (const pid of proc.pids()) {
    const stat = proc.stat(pid);
    const ppid = stat === null ? null : ppidOf(stat);
    if (ppid === null || pid === ppid) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const tree: number[] = [];
  const seen = new Set<number>();
  for (const queue = [root]; queue.length > 0;) {
    const pid = queue.shift() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    tree.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return tree;
}

interface Listener {
  readonly inode: string;
  /** How the guest can dial it: through IPv4 loopback, IPv6 loopback, or not at all (bound to another address). */
  readonly via: "v4" | "v6" | null;
}

// `/proc/net/tcp*` print each 32-bit word of an address in host order: little-endian on x86_64, pap's only VM architecture.
const V4_DIAL: ReadonlySet<string> = new Set(["00000000", "0100007F"]);
const V6_ANY = "00000000000000000000000000000000";
const V6_LOOP = "00000000000000000000000001000000";
const V6_MAPPED_V4_LOOP = "0000000000000000FFFF00000100007F";
const LISTEN = "0A";

/** The LISTEN sockets of one table on `port`. */
export function listenersOn(table: string, port: number, family: "v4" | "v6"): Listener[] {
  const found: Listener[] = [];
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    const local = fields[1];
    const inode = fields[9];
    if (fields[3] !== LISTEN || local === undefined || inode === undefined || !/^\d+$/.test(inode)) continue;
    const colon = local.lastIndexOf(":");
    if (colon < 0 || Number.parseInt(local.slice(colon + 1), 16) !== port) continue;
    const address = local.slice(0, colon).toUpperCase();
    const via =
      family === "v4"
        ? V4_DIAL.has(address)
          ? "v4"
          : null
        : address === V6_MAPPED_V4_LOOP
          ? "v4"
          : address === V6_ANY || address === V6_LOOP
            ? "v6"
            : null;
    found.push({ inode, via });
  }
  return found;
}

const SOCKET_LINK = /^socket:\[(\d+)\]$/;

/**
 * Spec §5 (controller's call): a service is `running` only when every socket listening on its port, in its own network
 * namespace, belongs to its own process tree (the bwrap it was started with and every descendant). A listener of anything
 * else in the VM (Pi, an MCP server, another service) on that port is `port_not_owned`; no listener yet, or one the guest
 * cannot dial (bound to another address), is `not_listening`. The tunnel checks again before each connection.
 */
export function checkOwnership(root: number, port: number, from: NetnsFrom, proc: ProcReader): Ownership {
  if (proc.stat(root) === null) return { owned: false, reason: "gone" };
  const tree = treeOf(root, proc);
  const nsPid = from === "root" ? root : tree.find((pid) => pid !== root);
  if (nsPid === undefined) return { owned: false, reason: "not_listening" };
  // Pinned before anything of the namespace is read, and read again after the scan: a pid reused in between is `gone`.
  const startOf = (): string | null => {
    const line = proc.stat(nsPid);
    return line === null ? null : startTimeOf(line);
  };
  const nsStart = startOf();
  if (nsStart === null) return { owned: false, reason: "gone" };
  const tables = proc.tcpTables(nsPid);
  if (tables === null) return { owned: false, reason: "gone" };
  const listeners = [...listenersOn(tables.v4, port, "v4"), ...listenersOn(tables.v6, port, "v6")];
  if (listeners.length === 0) return { owned: false, reason: "not_listening" };
  const inodes = new Set<string>();
  for (const pid of tree)
    for (const link of proc.fdLinks(pid)) {
      const inode = SOCKET_LINK.exec(link)?.[1];
      if (inode !== undefined) inodes.add(inode);
    }
  if (!listeners.every((listener) => inodes.has(listener.inode)))
    return { owned: false, reason: "port_not_owned" };
  if (startOf() !== nsStart) return { owned: false, reason: "gone" };
  if (listeners.some((listener) => listener.via === "v4"))
    return { owned: true, host: "127.0.0.1", nsPid, nsStart };
  if (listeners.some((listener) => listener.via === "v6"))
    return { owned: true, host: "::1", nsPid, nsStart };
  return { owned: false, reason: "not_listening" };
}

const read = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** The guest's `/proc` (guest root reads every process of the VM, sandboxed ones included). */
export function procReader(root = "/proc"): ProcReader {
  return {
    pids: () => {
      try {
        return readdirSync(root)
          .filter((name) => /^\d+$/.test(name))
          .map(Number);
      } catch {
        return [];
      }
    },
    stat: (pid) => read(`${root}/${pid}/stat`),
    fdLinks: (pid) => {
      try {
        return readdirSync(`${root}/${pid}/fd`).flatMap((fd) => {
          try {
            return [readlinkSync(`${root}/${pid}/fd/${fd}`)];
          } catch {
            return [];
          }
        });
      } catch {
        return [];
      }
    },
    tcpTables: (pid) => {
      const v4 = read(`${root}/${pid}/net/tcp`);
      const v6 = read(`${root}/${pid}/net/tcp6`);
      return v4 === null && v6 === null ? null : { v4: v4 ?? "", v6: v6 ?? "" };
    },
  };
}
