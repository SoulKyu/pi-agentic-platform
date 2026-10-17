import { lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { probeSandbox, trustedBinary, type SandboxProbe } from "../../kernel/sandbox/probe.ts";
import { LastCheck } from "../../update-check.ts";
import { knownMigrationIds, schemaStatus } from "../ops/schema-status.ts";
import { opsDir, readJsonBounded } from "../ops/paths.ts";
import type { Check, CheckResult, CheckStatus, DoctorContext } from "./types.ts";

/** What the daemon checks read from the machine besides the home. Tests replace these. */
export interface DaemonProbes {
  /** The migration ids this release carries. */
  known(): ReadonlySet<string>;
  /** The real sandbox probe (M11R19) on the context's clock. `override` is `PAP_BWRAP`. */
  sandbox(override: string | undefined, ctx: DoctorContext): Promise<SandboxProbe>;
  /** `trustedBinary`: the real path of a root-owned binary, else null. */
  trusted(path: string): string | null;
}

export function defaultDaemonProbes(): DaemonProbes {
  return {
    known: knownMigrationIds,
    sandbox: (override, ctx) => probeSandbox(override, { timers: ctx.clock }),
    trusted: (path) => trustedBinary(path),
  };
}

const DAY_MS = 86_400_000;
const STALE_BACKUP_MS = 30 * DAY_MS;
const BIG_BACKUPS_BYTES = 2 * 1024 ** 3;
const PENDING_MAX_BYTES = 65_536;
const FILE_MAX_BYTES = 4_096;
const BACKUP_LIST_MAX = 5_000;
/** The three system paths M11's egress proxy accepts (modules/egress/python-probe.ts). */
const PYTHON_CANDIDATES = ["/usr/bin/python3", "/usr/local/bin/python3", "/bin/python3"] as const;
const RANK: Record<CheckStatus, number> = { ok: 0, skip: 0, info: 1, warn: 2, fail: 3 };

/** What `pap backup` writes (cli/backup/create.ts). Strings are charset-limited: a value that fails reads as damaged and is never shown. */
const LastBackup = z.strictObject({
  createdAt: z.string().regex(/^[0-9TZ:.+-]{10,40}$/),
  file: z.string().regex(/^[A-Za-z0-9._-]{1,255}$/),
  encrypted: z.boolean(),
  secrets: z.enum(["included", "excluded"]),
});

const codeOf = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? "unknown";
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

const schemaCheck = (probes: DaemonProbes): Check => ({
  id: "schema",
  title: "Database schema",
  async run(ctx) {
    const known = probes.known();
    const { state, ids } = schemaStatus(join(ctx.home, "state.db"), known, {
      noWrite: { lockHeld: ctx.lockHeld },
    });
    switch (state) {
      case "absent":
        return { status: "ok", detail: "no data yet: the database is created at the first start" };
      case "current":
        return {
          status: "ok",
          detail: `the database is at this release's schema (${ids.length} migrations)`,
        };
      case "pending":
        return {
          status: "ok",
          detail: `${known.size - ids.length} migration(s) will run at the next start; a snapshot is taken first`,
        };
      case "newer":
        return {
          status: "fail",
          detail: "this database was written by a newer pap and opens read-only",
          fix: "update pap, or `pap restore <backup>`",
        };
      case "damaged":
        return {
          status: "fail",
          detail: "state.db is damaged or cannot be read",
          fix: "pap restore <backup>",
        };
      case "unread":
        return {
          status: "info",
          detail: "a write-ahead log from a crash is waiting; it is applied at the next start",
        };
    }
  },
});

const updatePendingCheck: Check = {
  id: "update_pending",
  title: "Interrupted update",
  async run(ctx) {
    const path = join(opsDir(ctx.home), "pending.json");
    let found: ReturnType<typeof lstatSync>;
    try {
      found = lstatSync(path);
    } catch (error) {
      if (codeOf(error) === "ENOENT")
        return { status: "ok", detail: "no update is in progress or interrupted" };
      return {
        status: "warn",
        detail: `cannot inspect ${path} (${codeOf(error)})`,
        fix: `ls -l ${path}`,
      };
    }
    if (!found.isFile() || found.size > PENDING_MAX_BYTES)
      return {
        status: "fail",
        detail: `the update journal ${path} is damaged (not a regular file, or above 64 KiB): delete it only after the two commands below and \`pap doctor\` look right`,
        fix: `ls -l ${path} && systemctl --user status ${ctx.unitName}`,
      };
    return {
      status: "fail",
      detail: `an update is running or was interrupted: ${path}, written ${new Date(found.mtimeMs).toISOString()}`,
      fix:
        ctx.unitName === "pap.service" ? "pap update recover" : `pap update recover --unit ${ctx.unitName}`,
    };
  },
};

/** The `pap-backup-*` files of the default folder (`--out` elsewhere is not counted): readdir and lstat only. */
function backupBytes(home: string): { bytes: number; unreadable: string | null } {
  const dir = join(home, "backups");
  let bytes = 0;
  try {
    for (const name of readdirSync(dir).slice(0, BACKUP_LIST_MAX)) {
      if (!name.startsWith("pap-backup-")) continue;
      const found = lstatSync(join(dir, name));
      if (found.isFile()) bytes += found.size;
    }
  } catch (error) {
    // no folder yet is nothing to count; anything else is said
    return { bytes, unreadable: codeOf(error) === "ENOENT" ? null : codeOf(error) };
  }
  return { bytes, unreadable: null };
}

const backupCheck: Check = {
  id: "backup",
  title: "Last backup",
  async run(ctx) {
    const record = readJsonBounded(join(opsDir(ctx.home), "last-backup.json"), LastBackup, FILE_MAX_BYTES);
    const parts: Array<{ status: CheckStatus; detail: string; fix?: string }> = [];
    if (record === null)
      parts.push({ status: "info", detail: "no backup made with `pap backup`", fix: "pap backup" });
    else if (record === "damaged" || Number.isNaN(Date.parse(record.createdAt)))
      parts.push({
        status: "warn",
        detail: "the record of the last backup is unreadable",
        fix: "pap backup",
      });
    else {
      const age = Math.max(0, ctx.clock.now() - Date.parse(record.createdAt));
      const days = Math.floor(age / DAY_MS);
      const what = `${record.encrypted ? "encrypted" : "not encrypted"}, secrets ${record.secrets === "included" ? "included" : "not included"}`;
      parts.push(
        age > STALE_BACKUP_MS
          ? {
              status: "warn",
              detail: `the last backup is ${plural(days, "day")} old (${record.file}); ${what}`,
              fix: "pap backup",
            }
          : { status: "ok", detail: `last backup ${plural(days, "day")} ago (${record.file}); ${what}` },
      );
    }
    const { bytes, unreadable } = backupBytes(ctx.home);
    if (unreadable !== null)
      parts.push({
        status: "info",
        detail: `cannot read ${join(ctx.home, "backups")} (${unreadable}): its size is not counted`,
        fix: `ls -ld ${join(ctx.home, "backups")}`,
      });
    if (bytes > BIG_BACKUPS_BYTES)
      parts.push({
        status: "info",
        detail: `${(bytes / 1024 ** 3).toFixed(1)} GiB of pap-backup files in ${join(ctx.home, "backups")}`,
        fix: "pap backup --keep N removes the older ones",
      });
    const worst = parts.reduce((a, b) => (RANK[b.status] > RANK[a.status] ? b : a));
    const fix = parts.find((p) => p.status === worst.status && p.fix !== undefined)?.fix;
    return {
      status: worst.status,
      detail: parts.map((p) => p.detail).join("; "),
      ...(fix === undefined ? {} : { fix }),
    };
  },
};

const bwrapCheck = (probes: DaemonProbes): Check => ({
  id: "bwrap",
  title: "Sandbox (bubblewrap)",
  async run(ctx) {
    // the daemon reads PAP_BWRAP from the unit's environment; the shell's only counts when no unit exists
    const raw = (ctx.unit === null ? ctx.env : ctx.unit.env).PAP_BWRAP;
    const override = raw !== undefined && isAbsolute(raw) ? raw : undefined;
    const probe = await probes.sandbox(override, ctx);
    if (probe.usable) return { status: "ok", detail: `bubblewrap works (${probe.path})` };
    switch (probe.reason) {
      case "missing":
        return {
          status: "warn",
          detail: "bubblewrap is not installed: agents that require the sandbox cannot start",
          fix: "sudo apt install bubblewrap",
        };
      case "unsafe_path":
        return {
          status: "warn",
          detail:
            "bubblewrap is present but not a root-owned binary in root-owned folders: pap will not run it",
          fix: "sudo apt install --reinstall bubblewrap",
        };
      case "refused":
        return {
          status: "warn",
          detail:
            "bubblewrap is present but the sandbox probe failed: agents that require the sandbox cannot start",
          fix: ctx.inContainer
            ? "start the container with `--security-opt systempaths=unconfined` (scripts/pap-container.sh run); on Ubuntu also check `kernel.apparmor_restrict_unprivileged_userns`"
            : "on Ubuntu check `sysctl kernel.apparmor_restrict_unprivileged_userns` (unprivileged user namespaces must be allowed to the system bwrap)",
        };
      case "timeout":
        return {
          status: "warn",
          detail: "the sandbox probe did not answer within 5 s",
          fix: "pap doctor --only bwrap",
        };
    }
  },
});

const python3Check = (probes: DaemonProbes): Check => ({
  id: "python3",
  title: "python3 for the egress proxy",
  async run() {
    for (const candidate of PYTHON_CANDIDATES) {
      const real = probes.trusted(candidate);
      if (real !== null) return { status: "ok", detail: `python3 is root-owned (${real})` };
    }
    return {
      status: "warn",
      detail: "no root-owned python3 in /usr/bin, /usr/local/bin or /bin: networked agents need it",
      fix: "sudo apt install python3",
    };
  },
});

const updateAvailableCheck: Check = {
  id: "update_available",
  title: "Update available",
  async run(ctx): Promise<CheckResult> {
    const record = readJsonBounded(join(opsDir(ctx.home), "last-check.json"), LastCheck, FILE_MAX_BYTES);
    if (record === null)
      return { status: "skip", detail: "no update check has run yet: `pap update check` asks the feed" };
    if (record === "damaged")
      return { status: "skip", detail: "the record of the last update check is unreadable" };
    return record.status === "newer"
      ? { status: "ok", detail: `${record.latest} is available on ${record.channel}: pap update install` }
      : { status: "ok", detail: `up to date (${record.current} on ${record.channel})` };
  },
};

export function makeDaemonChecks(probes: DaemonProbes): readonly Check[] {
  return [
    schemaCheck(probes),
    updatePendingCheck,
    backupCheck,
    bwrapCheck(probes),
    python3Check(probes),
    updateAvailableCheck,
  ];
}

export const CHECKS_DAEMON: readonly Check[] = makeDaemonChecks(defaultDaemonProbes());
