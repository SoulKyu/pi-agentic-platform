import { closeSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";

/**
 * Pi's bash tool starts every command with `detached: true`, so each command leads a session and a process group
 * of its own. Signalling the worker's group (what the daemon does) never reaches them, and `process.exit` leaves
 * them running. The SDK keeps a list of them and kills it on its own signals (`killTrackedDetachedChildren`), but
 * does not export it, so the worker finds its descendants itself: on Linux through the parent pid in /proc.
 *
 * This is the cover for every way the worker ends on its own terms: shutdown, a closed channel, an orphaned
 * worker, SIGTERM, SIGHUP. For SIGKILL and the OOM killer nothing runs in the worker; the cgroup of the systemd
 * scope (M2) is the only thing that reaches these processes then.
 */
export interface ProcEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly pgrp: number;
}

/** The parent and group of a process from its /proc/<pid>/stat line. The command name may hold spaces and ")". */
export function parseStat(text: string): { ppid: number; pgrp: number } | null {
  const rest = text
    .slice(text.lastIndexOf(")") + 1)
    .trim()
    .split(" ");
  const ppid = Number(rest[1]);
  const pgrp = Number(rest[2]);
  return rest.length >= 3 && Number.isInteger(ppid) && Number.isInteger(pgrp) ? { ppid, pgrp } : null;
}

/** The state letter of a /proc/<pid>/stat line (`Z` for a zombie), after a command name that may hold ")". */
export function stateOf(text: string): string | null {
  const close = text.lastIndexOf(")");
  return close < 0 ? null : (text.slice(close + 1).trim()[0] ?? null);
}

/** The table entry of a stat line; none for a line that is not one, and none for a zombie (it runs nothing and has no children left). */
export function entryOf(pid: number, text: string): ProcEntry | null {
  const stat = parseStat(text);
  const state = stateOf(text);
  return stat && state !== "Z" && state !== "X" ? { pid, ...stat } : null;
}

/** The most processes one read of /proc looks at: a bound on the time spent, far above any host a worker runs on. */
export const MAX_TABLE_ENTRIES = 32_768;

/**
 * Every live process: its parent and group. A process that exits between the listing and the read is left out, and a
 * zombie is too (it runs nothing and has no children left). A pid reused meanwhile is read once, as it is when read.
 */
export function readProcTable(limit = MAX_TABLE_ENTRIES): ProcEntry[] {
  const table: ProcEntry[] = [];
  for (const name of readdirSync("/proc")) {
    if (table.length >= limit) break;
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      const entry = entryOf(pid, readFileSync(`/proc/${pid}/stat`, "utf8"));
      if (entry) table.push(entry);
    } catch {
      // gone between the listing and the read
    }
  }
  return table;
}

/** Every process below `root`, children before their children, each once. */
export function descendantsOf(table: readonly ProcEntry[], root: number): ProcEntry[] {
  const found: ProcEntry[] = [];
  const seen = new Set<number>([root]);
  for (let queue = [root]; queue.length > 0;) {
    const next: number[] = [];
    for (const parent of queue) {
      for (const entry of table) {
        if (entry.ppid !== parent || seen.has(entry.pid)) continue;
        seen.add(entry.pid);
        found.push(entry);
        next.push(entry.pid);
      }
    }
    queue = next;
  }
  return found;
}

export interface CleanupEnv {
  platform: NodeJS.Platform;
  pid: number;
  readTable(): ProcEntry[];
  kill(pid: number, signal: NodeJS.Signals): void;
}

const realEnv = (): CleanupEnv => ({
  platform: process.platform,
  pid: process.pid,
  readTable: readProcTable,
  kill: (pid, signal) => void process.kill(pid, signal),
});

/**
 * SIGKILLs every descendant of this process, and the group of each descendant that leads one. Returns how many
 * descendants it signalled. Never throws.
 *
 * Only a worker that leads a group of its own (the daemon forks it `detached`) does this: run by hand in a shell it
 * touches nothing, and it never signals its own group, whose other members are not its descendants. A process id
 * can be recycled between the read of /proc and the kill; the window is a few milliseconds.
 */
function sweep({ pid, readTable, kill }: CleanupEnv): number {
  try {
    const table = readTable();
    const self = table.find((entry) => entry.pid === pid);
    if (!self || self.pgrp !== pid) return 0;
    const below = descendantsOf(table, pid);
    const leaders = new Set(below.map((entry) => entry.pid));
    const groups = [...new Set(below.map((entry) => entry.pgrp))].filter(
      (pgrp) => pgrp !== pid && leaders.has(pgrp),
    );
    const attempt = (target: number): boolean => {
      try {
        kill(target, "SIGKILL");
        return true;
      } catch {
        return false;
      }
    };
    for (const group of groups) attempt(-group);
    return below.filter((entry) => attempt(entry.pid)).length;
  } catch {
    return 0;
  }
}

/** Processes forked while a sweep ran are found by the next one; three sweeps cover a shell and its children. */
export const MAX_SWEEPS = 3;

export function killDetachedDescendants(env: Partial<CleanupEnv> = {}): number {
  const resolved = { ...realEnv(), ...env };
  if (resolved.platform !== "linux") return 0;
  let total = 0;
  for (let round = 0; round < MAX_SWEEPS; round++) {
    const killed = sweep(resolved);
    total += killed;
    if (killed === 0) break;
  }
  return total;
}

/**
 * On SIGTERM and SIGHUP: clean up, then die of the same signal. The handler is a `once`, so the signal it raises
 * again takes its default action and the daemon still reads the exit as a signal, as it did before there was a
 * handler.
 */
export function installSignalCleanup(
  proc: NodeJS.Process = process,
  cleanup: () => unknown = killDetachedDescendants,
): void {
  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    proc.once(signal, () => {
      try {
        cleanup();
      } catch {
        // The worker is going down either way.
      }
      proc.kill(proc.pid, signal);
    });
  }
}

/** What one count looks at, at most: a worker's scope allows 4096 tasks (spec C 2.5), and no process tree is deeper than a few levels. */
export const MAX_COUNTED_PROCESSES = 4096;
export const MAX_COUNT_DEPTH = 32;
/** The most of one process's environment that is read to look for the worker's marker, and of all of them in one count. */
export const MAX_ENVIRON_BYTES = 256 * 1024;
export const MAX_ENVIRON_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_SCOPE_FILE_BYTES = 1024 * 1024;
export const SCOPE_PROCS_FILE = "cgroup.procs";
/** The variable pi-host sets in its own environment before Pi starts: the shells Pi's tools run inherit it. */
export const TOKEN_VAR = "PAP_WORKER_TOKEN";
const MIN_TOKEN_CHARS = 16;
/** The unit of a worker the daemon scoped (`scope.ts`): `pap-<home>-worker-<id>-<n>.scope`. Any other scope is not the worker's. */
const SCOPE_LEAF = /^pap-.+-worker-.+\.scope$/;
const CGROUP_ROOT = "/sys/fs/cgroup";

/** At most `max` bytes of a file as text; null when it cannot be opened or read. Never throws. */
export function readBounded(path: string, max: number): string | null {
  let fd = -1;
  try {
    fd = openSync(path, "r");
    const chunk = Buffer.allocUnsafe(Math.min(max, 16 * 1024));
    const parts: Buffer[] = [];
    for (let total = 0; total < max;) {
      const read = readSync(fd, chunk, 0, Math.min(chunk.length, max - total), null);
      if (read === 0) break;
      parts.push(Buffer.from(chunk.subarray(0, read)));
      total += read;
    }
    return Buffer.concat(parts).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // nothing left to release
      }
    }
  }
}

export interface CountEnv {
  platform: NodeJS.Platform;
  pid: number;
  readTable(): ProcEntry[];
  /** A file as text, at most `max` bytes of it; null when it cannot be read. Tests hand in a world of files. */
  readFile(path: string, max: number): string | null;
  /** The worker's marker (`PAP_WORKER_TOKEN`): what its tools' processes carry in their environment. */
  token: string | undefined;
  maxVisited: number;
  maxDepth: number;
  maxEnvironTotal: number;
  warn(line: string): void;
}

let warnedOnce = false;
const realCountEnv = (): CountEnv => ({
  platform: process.platform,
  pid: process.pid,
  readTable: readProcTable,
  readFile: readBounded,
  token: process.env[TOKEN_VAR],
  maxVisited: MAX_COUNTED_PROCESSES,
  maxDepth: MAX_COUNT_DEPTH,
  maxEnvironTotal: MAX_ENVIRON_TOTAL_BYTES,
  warn: (line) => void process.stderr.write(line),
});

/** The pids in the worker's own scope, or null when the worker is not in one of pap's or the file cannot be read. */
function scopeMembers(env: CountEnv): number[] | null {
  const line = env
    .readFile("/proc/self/cgroup", MAX_SCOPE_FILE_BYTES)
    ?.split("\n")
    .find((l) => l.startsWith("0::"));
  const path = line?.slice(3).trim();
  if (
    !path?.startsWith("/") ||
    path.split("/").includes("..") ||
    !SCOPE_LEAF.test(path.slice(path.lastIndexOf("/") + 1))
  ) {
    return null;
  }
  const members = env.readFile(`${CGROUP_ROOT}${path}/${SCOPE_PROCS_FILE}`, MAX_SCOPE_FILE_BYTES);
  if (members === null) return null;
  return members
    .split("\n")
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .slice(0, env.maxVisited);
}

/** The processes outside the worker's group whose environment carries its marker; reads are bounded per process and in all. */
function markedProcesses(env: CountEnv, table: readonly ProcEntry[]): number[] {
  const { token } = env;
  if (token === undefined || token.length < MIN_TOKEN_CHARS) return [];
  const wanted = `${TOKEN_VAR}=${token}`;
  const found: number[] = [];
  let spent = 0;
  for (const entry of table) {
    if (entry.pgrp === env.pid || entry.pid === env.pid) continue;
    if (spent >= env.maxEnvironTotal) break;
    const text = env.readFile(
      `/proc/${entry.pid}/environ`,
      Math.min(MAX_ENVIRON_BYTES, env.maxEnvironTotal - spent),
    );
    if (text === null) continue;
    spent += text.length;
    if (text.split("\0").includes(wanted)) found.push(entry.pid);
  }
  return found;
}

/**
 * How many live processes the agent started that still run for this worker (M2R107), outside the worker's own process
 * group (Pi's bash tool starts each command in a group of its own; the helpers the worker runs itself, such as MCP
 * servers, share its group and do not count). The daemon keeps a worker whose agent left some running. Three sources,
 * one count of the union:
 * - the worker's descendants, which is all there is while a tool call still runs;
 * - once the tool's shell has exited, what it started with `cmd &` belongs to pid 1 and is no descendant: in a scoped
 *   worker (`systemd-run --scope`, spec C 2.5) the members of the worker's own cgroup;
 * - without a scope, the processes whose environment carries `PAP_WORKER_TOKEN`, which pi-host set before Pi started
 *   (same-user processes only are readable, and a process that scrubs its environment is not seen).
 * 0 off Linux and when the worker does not lead its group (run by hand). Never throws; a failed read says so once on
 * stderr. Bounded: `maxVisited` processes and `maxDepth` levels for the walk, `maxVisited` scope members, and
 * `MAX_ENVIRON_BYTES` per environment, `MAX_ENVIRON_TOTAL_BYTES` in all. A process that exits during the pass is
 * either counted (it was alive when read) or not, never an error; each pid counts once.
 */
export function countAgentProcesses(env: Partial<CountEnv> = {}): number {
  const resolved = { ...realCountEnv(), ...env };
  const { platform, pid, readTable, maxVisited, maxDepth, warn } = resolved;
  if (platform !== "linux") return 0;
  try {
    const table = readTable();
    const self = table.find((entry) => entry.pid === pid);
    if (!self || self.pgrp !== pid) return 0;
    const byPid = new Map<number, ProcEntry>();
    const children = new Map<number, ProcEntry[]>();
    for (const entry of table) {
      if (!byPid.has(entry.pid)) byPid.set(entry.pid, entry);
      const parent = entry.ppid;
      const siblings = children.get(parent);
      if (siblings) siblings.push(entry);
      else children.set(parent, [entry]);
    }
    const seen = new Set<number>([pid]);
    const agents = new Set<number>();
    let visited = 0;
    let level = [pid];
    for (let depth = 0; depth < maxDepth && level.length > 0; depth++) {
      const next: number[] = [];
      for (const parent of level) {
        for (const child of children.get(parent) ?? []) {
          if (seen.has(child.pid)) continue;
          if (visited >= maxVisited) break;
          visited++;
          seen.add(child.pid);
          next.push(child.pid);
          if (child.pgrp !== pid) agents.add(child.pid);
        }
      }
      level = next;
    }
    const members = scopeMembers(resolved);
    const reparented =
      members?.flatMap((member) => {
        const entry = byPid.get(member);
        return entry && entry.pgrp !== pid ? [entry.pid] : [];
      }) ?? markedProcesses(resolved, table);
    for (const found of reparented) agents.add(found);
    return agents.size;
  } catch (error) {
    if (!warnedOnce) {
      warnedOnce = true;
      warn(`pi-host: the process count failed: ${error instanceof Error ? error.message : "unknown"}\n`);
    }
    return 0;
  }
}
