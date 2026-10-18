import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { freeMb, type Statfs } from "../../kernel/disk.ts";
import { whichOnPath } from "../../kernel/which.ts";
import type { Check, CheckResult, CheckStatus, DoctorContext } from "./types.ts";

export interface PathStat {
  readonly mode: number;
  readonly uid: number;
  readonly kind: "dir" | "file" | "link" | "other";
}

/** What the system checks read from the machine. Tests replace these; nothing here writes. */
export interface SystemProbes {
  readonly nodeVersion: string;
  /** The user pap runs as. */
  readonly uid: number;
  readonly statfs?: Statfs;
  /** `stat` when `follow`, else `lstat`; null when the path does not exist, a throw for any other error. */
  readonly stat: (path: string, follow: boolean) => PathStat | null;
  readonly journalDirExists: () => boolean;
  /** The text of `journald.conf` and of `journald.conf.d/*.conf`. */
  readonly journaldConf: () => readonly string[];
}

const MIN_FREE_DEFAULT_MB = 1024;
const TOOLS = ["gcc", "g++", "make", "python3"] as const;
const SKIPPED: CheckResult = { status: "skip", detail: "not applicable in a container" };
const SOURCE: Record<DoctorContext["homeSource"], string> = {
  flag: "the flag",
  unit: "the unit",
  environment: "the environment",
  default: "the default",
};
const RANK: Record<CheckStatus, number> = { ok: 0, skip: 0, info: 1, warn: 2, fail: 3 };

function readCapped(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(65_536);
    return buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, null));
  } finally {
    closeSync(fd);
  }
}

function conf(): string[] {
  const dir = "/etc/systemd/journald.conf.d";
  const files = ["/etc/systemd/journald.conf"];
  try {
    for (const name of readdirSync(dir).sort().slice(0, 50))
      if (name.endsWith(".conf")) files.push(join(dir, name));
  } catch {
    // no drop-in folder
  }
  const texts: string[] = [];
  for (const file of files) {
    try {
      texts.push(readCapped(file));
    } catch {
      // absent or unreadable: it says nothing
    }
  }
  return texts;
}

export function defaultProbes(): SystemProbes {
  return {
    nodeVersion: process.versions.node,
    uid: process.getuid?.() ?? -1,
    stat(path, follow) {
      try {
        const s = follow ? statSync(path) : lstatSync(path);
        const kind = s.isDirectory() ? "dir" : s.isFile() ? "file" : s.isSymbolicLink() ? "link" : "other";
        return { mode: s.mode, uid: s.uid, kind };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    journalDirExists: () => existsSync("/var/log/journal"),
    journaldConf: conf,
  };
}

const codeOf = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? "unknown";
const octal = (mode: number): string => (mode & 0o777).toString(8).padStart(3, "0");

// The same bounds as package.json engines.node (">=24.14 <25"); the daemon cannot import package.json.
const NODE_TESTED_MAJOR = 24;
const NODE_MIN_MINOR = 14;

const nodeCheck = (probes: SystemProbes): Check => ({
  id: "node",
  title: "Node.js version",
  async run() {
    const match = /^(\d+)\.(\d+)\./.exec(probes.nodeVersion);
    const major = Number(match?.[1]);
    const minor = Number(match?.[2]);
    if (match !== null && major > NODE_TESTED_MAJOR) {
      return {
        status: "warn",
        detail: `pap is tested on Node ${NODE_TESTED_MAJOR}; Node ${major} is not supported yet`,
        fix: `use Node ${NODE_TESTED_MAJOR}.${NODE_MIN_MINOR} or a newer ${NODE_TESTED_MAJOR}.x (docs/agents/install.md)`,
      };
    }
    const fine = match !== null && major === NODE_TESTED_MAJOR && minor >= NODE_MIN_MINOR;
    return fine
      ? { status: "ok", detail: `node ${probes.nodeVersion}` }
      : {
          status: "fail",
          detail: `node ${probes.nodeVersion} is too old; pap needs 24.14 or newer`,
          fix: "install Node 24.14 or newer (docs/agents/install.md)",
        };
  },
});

const toolchainCheck: Check = {
  id: "toolchain",
  title: "Build tools",
  async run(ctx) {
    const missing = TOOLS.filter((tool) => whichOnPath(tool, ctx.env) === null);
    return missing.length === 0
      ? { status: "ok", detail: `${TOOLS.join(" ")} found` }
      : {
          status: "info",
          detail: `missing: ${missing.join(", ")} (only needed for method 1 and \`npm install\`)`,
          fix: "sudo apt install build-essential python3",
        };
  },
};

const userManagerCheck: Check = {
  id: "user_manager",
  title: "systemd user manager",
  async run(ctx) {
    if (ctx.inContainer) return SKIPPED;
    let up = false;
    try {
      up = await ctx.systemd.userManagerUp();
    } catch {
      // systemctl missing or too slow: the same answer as "not reachable"
    }
    return up
      ? { status: "ok", detail: "the user manager answers" }
      : {
          status: "fail",
          detail:
            "the systemd user manager does not answer (is this an SSH or console login with XDG_RUNTIME_DIR set?)",
          fix: "loginctl enable-linger, then log in again (docs/agents/install.md)",
        };
  },
};

const lingerCheck = (probes: SystemProbes): Check => ({
  id: "linger",
  title: "Linger",
  async run(ctx) {
    if (ctx.inContainer) return SKIPPED;
    let on = false;
    try {
      on = await ctx.systemd.lingerEnabled(probes.uid);
    } catch {
      // loginctl missing: not enabled as far as pap can tell
    }
    return on
      ? { status: "ok", detail: "linger is on: pap survives logout and starts at boot" }
      : {
          status: "warn",
          detail:
            "linger is off: pap stops at logout and does not start at boot, and agent workers lose their scope",
          fix: "loginctl enable-linger",
        };
  },
});

const journalCheck = (probes: SystemProbes): Check => ({
  id: "journal",
  title: "User journal",
  async run(ctx) {
    if (ctx.inContainer) return SKIPPED;
    const persistent =
      probes.journalDirExists() ||
      probes.journaldConf().some((text) => /^\s*Storage\s*=\s*persistent\s*$/im.test(text));
    const fix = "sudo mkdir -p /var/log/journal && sudo systemctl restart systemd-journald";
    if (!persistent)
      return {
        status: "warn",
        detail: "the journal is not persistent: the user journal pap reads to verify a start may be empty",
        fix,
      };
    let active = false;
    try {
      active = await ctx.systemd.isActive(ctx.unitName);
    } catch {
      // cannot tell: nothing to look for
    }
    if (!active) return { status: "ok", detail: "the journal is persistent" };
    let text: string;
    try {
      const since = await ctx.systemd.activeSince(ctx.unitName);
      if (since === null) return { status: "ok", detail: "the journal is persistent" };
      text = await ctx.systemd.journalAny(since);
    } catch {
      // a read that failed is not an empty journal: it gets its own sentence
      return {
        status: "warn",
        detail: `the journal of ${ctx.unitName} cannot be read`,
        fix: `journalctl --user -u ${ctx.unitName} -n 5`,
      };
    }
    return text.trim() === ""
      ? {
          status: "warn",
          detail: `the journal holds no line for ${ctx.unitName}: \`pap service install\` and \`pap update apply\` cannot verify a start (exit 3)`,
          fix,
        }
      : { status: "ok", detail: `the journal is persistent and holds lines for ${ctx.unitName}` };
  },
});

function floorOf(ctx: DoctorContext): number {
  // the daemon reads the unit's environment; the shell's only counts when no unit exists
  const raw = (ctx.unit === null ? ctx.env : ctx.unit.env).PAP_MIN_FREE_DISK_MB;
  return raw !== undefined && /^\d{1,9}$/.test(raw) ? Number(raw) : MIN_FREE_DEFAULT_MB;
}

const diskCheck = (probes: SystemProbes): Check => ({
  id: "disk",
  title: "Free disk space",
  async run(ctx) {
    const floor = floorOf(ctx);
    if (floor <= 0) return { status: "skip", detail: "PAP_MIN_FREE_DISK_MB=0: the disk floor is off" };
    const free = freeMb(ctx.home, probes.statfs);
    if (free === null)
      return {
        status: "warn",
        detail: `cannot read the free space of the disk holding ${ctx.home}`,
        fix: `df -h ${ctx.home}`,
      };
    const detail = `${free} MB free on the disk holding ${ctx.home} (floor ${floor} MB)`;
    if (free < floor)
      return {
        status: "fail",
        detail: `${detail}: forks, task sessions and lanes are refused`,
        fix: `du -sh ${ctx.home}/* | sort -h`,
      };
    return free < floor * 3
      ? {
          status: "warn",
          detail: `${detail}: less than three times the floor`,
          fix: `du -sh ${ctx.home}/* | sort -h`,
        }
      : { status: "ok", detail };
  },
});

const homeCheck = (probes: SystemProbes): Check => ({
  id: "home",
  title: "Data folder",
  async run(ctx) {
    const where = `${ctx.home} (from ${SOURCE[ctx.homeSource]})`;
    let dir: PathStat | null;
    try {
      dir = probes.stat(ctx.home, true);
    } catch (error) {
      return { status: "warn", detail: `cannot read ${where} (${codeOf(error)})`, fix: `ls -ld ${ctx.home}` };
    }
    if (dir === null)
      return { status: "info", detail: `${where} does not exist yet: it is created at the first start` };
    if (dir.kind !== "dir")
      return { status: "fail", detail: `${where} is not a folder`, fix: `mv ${ctx.home} ${ctx.home}.old` };
    if (dir.uid !== probes.uid)
      return {
        status: "fail",
        detail: `${where} belongs to uid ${dir.uid}, pap runs as uid ${probes.uid}`,
        fix: `sudo chown -R $USER ${ctx.home}`,
      };
    const found: Array<{ status: CheckStatus; detail: string; fix?: string }> = [];
    if ((dir.mode & 0o077) !== 0)
      found.push({
        status: "warn",
        detail: `the folder is open to other users (mode ${octal(dir.mode)}): tightened at the next start`,
        fix: `chmod 700 ${ctx.home}`,
      });
    const databasePath = join(ctx.home, "state.db");
    let database: PathStat | null = null;
    try {
      database = probes.stat(databasePath, false);
    } catch {
      // unreadable database entry: the folder verdict stands
    }
    if (database?.kind === "file" && (database.mode & 0o077) !== 0)
      found.push({
        status: "warn",
        detail: `state.db is open to other users (mode ${octal(database.mode)}): tightened at the next start`,
        fix: `chmod 600 ${databasePath}`,
      });
    const shell = ctx.env.PAP_HOME;
    const unitHome = ctx.unit?.home ?? null;
    if (unitHome !== null && shell !== undefined && shell !== "" && resolve(shell) !== resolve(unitHome))
      found.push({
        status: "info",
        detail: `PAP_HOME in this shell (${shell}) differs from the unit's home: pap commands follow the unit's home`,
      });
    if (found.length === 0) return { status: "ok", detail: `${where}, mode ${octal(dir.mode)}` };
    const worst = found.reduce((a, b) => (RANK[b.status] > RANK[a.status] ? b : a));
    const fixes = found.flatMap((f) => (f.fix === undefined ? [] : [f.fix]));
    return {
      status: worst.status,
      detail: `${where}: ${found.map((f) => f.detail).join("; ")}`,
      ...(fixes.length > 0 ? { fix: fixes.join(" && ") } : {}),
    };
  },
});

export function makeSystemChecks(probes: SystemProbes): readonly Check[] {
  return [
    nodeCheck(probes),
    toolchainCheck,
    userManagerCheck,
    lingerCheck(probes),
    journalCheck(probes),
    diskCheck(probes),
    homeCheck(probes),
  ];
}

export const CHECKS_SYSTEM: readonly Check[] = makeSystemChecks(defaultProbes());
