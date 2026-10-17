import { CliError, type CliIo } from "../open-home.ts";
import { installRoot } from "../ops/paths.ts";
import type { Command } from "../run-cli.ts";
import { UNVERIFIED_EXIT } from "../service/common.ts";
import { safePath } from "../service/unit.ts";
import { UsageError } from "../usage.ts";
import { applyRelease, ApplyRefused, type ApplyOutcome } from "./apply.ts";
import { DEFAULT_OP_SEAMS, inOperation, type OpSeams } from "./operation.ts";
import { checkedId, readCurrent } from "./releases.ts";
import { pruneSnapshots } from "./prune.ts";
import { EXIT_ROLLBACK_INCOMPLETE, recoverCommand } from "./rollback-report.ts";

export const APPLY_USAGE =
  "usage: pap update apply --release <id> [--app-root <abs>] [--deadline-s 30..600] [--settle-s 0..60] [--unit <name>]";
/** Exit codes besides 0 and 1: installed but unconfirmed (3), rolled back (4), rollback failed (5). */
export const EXIT_ROLLED_BACK = 4;

/** What touches the machine; tests replace these. */
export interface ApplySeams extends OpSeams {
  apply: typeof applyRelease;
}

const DEFAULT_SEAMS: ApplySeams = { ...DEFAULT_OP_SEAMS, apply: applyRelease };

function secondsFlag(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  const value = /^\d{1,4}$/.test(raw) ? Number(raw) : -1;
  if (value < min || value > max) throw new UsageError(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

interface Report {
  readonly unit: string;
  readonly home: string;
  readonly from: string;
  readonly to: string;
  readonly startedAt: string;
}

function finish(io: CliIo, outcome: ApplyOutcome, report: Report): number {
  const { unit, home, from, to } = report;
  const installed = (snapshot: string | null): void => {
    io.stdout.write(`updated: ${from} -> ${to}\n`);
    if (snapshot !== null)
      io.stdout.write(`database snapshot: backups/${snapshot} (kept; the three newest are kept)\n`);
    io.stdout.write("any running turn was interrupted\n");
  };
  switch (outcome.kind) {
    case "updated":
      installed(outcome.snapshot);
      return 0;
    case "unverified":
      installed(outcome.snapshot);
      io.stderr.write(
        `pap: installed, but the user journal is not readable, so the start of ${to} could not be confirmed (the health probe and the settle window passed); check: systemctl --user status ${unit}\n`,
      );
      return UNVERIFIED_EXIT;
    case "rolled_back":
      io.stderr.write(
        [
          `pap: update failed: ${outcome.reason}`,
          `the previous release (${from}) is back and running`,
          outcome.restoredDatabase
            ? `writes made since ${report.startedAt} were discarded: the restored database is the one the old release left; ${outcome.keptDatabase === undefined ? "no copy of the replaced database was kept (state.db was absent)" : `the database it replaced is kept as ${outcome.keptDatabase} (to get those writes back, stop pap and copy that file over ${home}/state.db)`}`
            : "the database was not restored (no migration ran)",
          "",
        ].join("\n"),
      );
      return EXIT_ROLLED_BACK;
    case "rollback_failed":
      io.stderr.write(
        [
          `pap: update failed: ${outcome.reason}`,
          `and the rollback to ${from} failed at: ${outcome.step}${outcome.code === undefined ? "" : ` (${outcome.code})`}`,
          ...(outcome.step === "database"
            ? [
                `the way out: pap restore, or the newest pre-update snapshot under ${home}/backups/ (pap stopped, then copy it over ${home}/state.db)`,
              ]
            : []),
          "run, in this order:",
          `  ${recoverCommand(unit)}`,
          `  systemctl --user status ${unit}`,
          "",
        ].join("\n"),
      );
      return EXIT_ROLLBACK_INCOMPLETE;
  }
}

export function makeApplyCommand(overrides: Partial<ApplySeams> = {}): Command {
  const seams: ApplySeams = { ...DEFAULT_SEAMS, ...overrides };
  return {
    options: {
      release: { type: "string" },
      "app-root": { type: "string" },
      "deadline-s": { type: "string" },
      "settle-s": { type: "string" },
      unit: { type: "string" },
      help: { type: "boolean" },
    },
    async run({ values, positionals, io }) {
      if (values.help === true) {
        io.stdout.write(`${APPLY_USAGE}\n`);
        return 0;
      }
      const str = (name: string): string | undefined =>
        typeof values[name] === "string" ? values[name] : undefined;
      if (positionals.length > 0) throw new UsageError("update apply takes no argument");
      const release = str("release");
      if (release === undefined) throw new UsageError("--release <id> is required");
      try {
        checkedId(release);
      } catch {
        throw new UsageError("--release is not a release id (letters, digits, . _ - only)");
      }
      const deadlineS = secondsFlag("--deadline-s", str("deadline-s"), 120, 30, 600);
      const settleS = secondsFlag("--settle-s", str("settle-s"), 10, 0, 60);
      const appFlag = str("app-root");
      let app: string;
      try {
        app = appFlag === undefined ? installRoot(io) : safePath("--app-root", appFlag);
      } catch {
        throw new CliError("--app-root must be an absolute path of letters, digits and . _ + @ / - only", 64);
      }

      return inOperation(io, seams, str("unit"), async (target) => {
        const report: Report = {
          unit: target.unit,
          home: target.home,
          from: readCurrent(app) ?? "unknown",
          to: release,
          startedAt: new Date(io.clock.now()).toISOString(),
        };
        const deps = await seams.makeDeps(io, target, {
          app,
          deadlineMs: deadlineS * 1000,
          settleMs: settleS * 1000,
        });
        let outcome: ApplyOutcome;
        try {
          outcome = await seams.apply(deps, release);
        } catch (error) {
          if (error instanceof ApplyRefused) throw new CliError(error.message);
          throw error;
        }
        if (outcome.kind === "updated" || outcome.kind === "unverified") {
          // M6b-C3: the success line promises "the three newest are kept"; a failure is said, the exit code stays
          const pruned = pruneSnapshots(target.home, outcome.snapshot);
          if (!pruned.ran) io.stderr.write("pap: could not list backups/ to remove old snapshots\n");
          else if (pruned.failed.length > 0)
            io.stderr.write(`pap: could not remove old snapshot(s) ${pruned.failed.join(", ")}\n`);
        }
        return finish(io, outcome, report);
      });
    },
  };
}

export const updateApply: Command = makeApplyCommand();
