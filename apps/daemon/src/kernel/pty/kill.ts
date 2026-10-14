import { readdir, readFile } from "node:fs/promises";
import type { Clock } from "../clock.ts";

export const PTY_HANGUP_GRACE_MS = 2000;
/** After the SIGKILL: node-pty may report the exit only once the last holder of the terminal is gone (RT-05). */
export const PTY_EXIT_WAIT_MS = 5000;
export const PROC_WALK_MAX = 32_768;
/** The SIGKILL pass is repeated while a fresh read still finds members (children forked during the walk). */
export const KILL_PASSES_MAX = 8;
const READ_CHUNK = 64;

export interface ProcEntry {
  readonly pid: number;
  /** Field 6 of /proc/<pid>/stat. */
  readonly sid: number;
  /** Field 22: clock ticks since boot; the same pid with another start is another process. */
  readonly start: string;
}

/** The fields after the command name, which may hold spaces and parentheses: the last `)` ends it. */
export function parseProcStat(pid: number, text: string): ProcEntry | null {
  const end = text.lastIndexOf(")");
  if (end < 0) return null;
  const fields = text.slice(end + 2).split(" ");
  const sid = Number(fields[3]);
  const start = fields[19];
  return Number.isInteger(sid) && start !== undefined && /^\d+$/.test(start) ? { pid, sid, start } : null;
}

export interface ProcReader {
  entry(pid: number): Promise<ProcEntry | null>;
  /** The pids /proc lists, at most PROC_WALK_MAX. */
  pids(): Promise<readonly number[]>;
}

// A process that vanished between the listing and the read, or a host without /proc, reads as "not there": the
// ladder then signals the group only, which is what it can still vouch for.
export const LINUX_PROC: ProcReader = {
  async entry(pid) {
    try {
      return parseProcStat(pid, await readFile(`/proc/${pid}/stat`, "utf8"));
    } catch {
      return null;
    }
  },
  async pids() {
    try {
      const pids: number[] = [];
      for (const name of await readdir("/proc")) {
        if (/^\d+$/.test(name)) pids.push(Number(name));
        if (pids.length >= PROC_WALK_MAX) break;
      }
      return pids;
    } catch {
      return [];
    }
  },
};

export interface PtyTarget {
  readonly pid: number;
  /** The shell's /proc start, read at spawn (null without /proc). */
  readonly start: string | null;
  readonly exited: Promise<unknown>;
}

/**
 * M8R55 (RT-05): the processes of the shell's session, the shell excluded: an interactive shell gives each job a
 * process group of its own, so the group signal misses them. Null when the pid now names another process: then
 * neither its group nor its session is ours. Linux keeps a session id from being reused while a member lives.
 */
export async function sessionMembers(target: PtyTarget, proc: ProcReader): Promise<number[] | null> {
  const leader = await proc.entry(target.pid);
  if (leader !== null && target.start !== null && leader.start !== target.start) return null;
  const members: number[] = [];
  const pids = (await proc.pids()).filter((pid) => pid !== target.pid);
  // Read in chunks: a walk over a busy host takes long enough for a forking job to outrun a sequential one.
  for (let at = 0; at < pids.length; at += READ_CHUNK) {
    const chunk = pids.slice(at, at + READ_CHUNK);
    const entries = await Promise.all(chunk.map((pid) => proc.entry(pid)));
    chunk.forEach((pid, i) => {
      if (entries[i]?.sid === target.pid) members.push(pid);
    });
  }
  return members;
}

type Signal = (target: number, name: NodeJS.Signals) => void;

const sendSignal: Signal = (target, name) => {
  try {
    process.kill(target, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
};

export interface KillDeps {
  readonly clock: Clock;
  /** `pty_kill_timeout`: the shell did not report its exit. `pty_kill_denied`: `count` members refused the signal (EPERM, e.g. under sudo). */
  readonly warn: (
    event: "pty_kill_timeout" | "pty_kill_denied",
    fields: { readonly pid: number; readonly count?: number },
  ) => void;
  readonly proc?: ProcReader;
  readonly signal?: Signal;
}

/** A clock delay that can be cancelled, so nothing stays armed once the ladder is done. */
function delay(clock: Clock, ms: number): { readonly done: Promise<"elapsed">; cancel(): void } {
  let handle: ReturnType<Clock["setTimeout"]> | null = null;
  const done = new Promise<"elapsed">((resolve) => {
    handle = clock.setTimeout(() => resolve("elapsed"), ms);
  });
  return {
    done,
    cancel() {
      if (handle !== null) clock.clearTimeout(handle);
    },
  };
}

/**
 * M8R55: SIGHUP to the shell's group and to every process of its session; SIGKILL to the same after 2 s unless
 * the shell exited and its session is empty (repeated, at most 8 passes, while a fresh read finds members: a job
 * that forks outruns one pass); then resolve on the shell's exit, or after 5 s more (logged). A process the daemon
 * may not signal (EPERM: sudo, su) is skipped and logged once per step; the others are still reached.
 */
export async function ptyKill(target: PtyTarget, deps: KillDeps): Promise<void> {
  if (!Number.isInteger(target.pid) || target.pid <= 1) throw new Error("refusing to signal pid <= 1");
  const proc = deps.proc ?? LINUX_PROC;
  const signal = deps.signal ?? sendSignal;
  const exited = target.exited.then(() => "exited" as const);
  const send = (pid: number, name: NodeJS.Signals, refused: Set<number>): void => {
    try {
      signal(pid, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      refused.add(pid);
    }
  };
  /** One pass. False (nothing signalled) when the pid now names another process, or when a repeat finds only members that refused. */
  const hit = async (name: NodeJS.Signals, refused: Set<number>, repeat = false): Promise<boolean> => {
    const members = await sessionMembers(target, proc);
    if (members === null) return false;
    const fresh = members.filter((pid) => !refused.has(pid));
    if (repeat && fresh.length === 0) return false;
    send(-target.pid, name, refused);
    for (const pid of fresh) send(pid, name, refused);
    return true;
  };
  const warnDenied = (refused: Set<number>): void => {
    if (refused.size > 0) deps.warn("pty_kill_denied", { pid: target.pid, count: refused.size });
  };
  const grace = delay(deps.clock, PTY_HANGUP_GRACE_MS);
  let wait: ReturnType<typeof delay> | null = null;
  try {
    const hangup = new Set<number>();
    await hit("SIGHUP", hangup);
    warnDenied(hangup);
    if ((await Promise.race([exited, grace.done])) === "exited") {
      const left = await sessionMembers(target, proc);
      if (left === null || left.length === 0) return;
      await grace.done;
    }
    wait = delay(deps.clock, PTY_EXIT_WAIT_MS);
    let over = false;
    void wait.done.then(() => {
      over = true;
    });
    const refused = new Set<number>();
    for (let pass = 0; pass < KILL_PASSES_MAX && !over; pass++) {
      if (!(await hit("SIGKILL", refused, pass > 0))) break;
    }
    warnDenied(refused);
    if ((await Promise.race([exited, wait.done])) === "elapsed")
      deps.warn("pty_kill_timeout", { pid: target.pid });
  } finally {
    grace.cancel();
    wait?.cancel();
  }
}
