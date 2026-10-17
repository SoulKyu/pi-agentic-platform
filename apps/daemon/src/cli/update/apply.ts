import { constants, copyFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { restoreDatabaseFile, schemaIds, SnapshotError, snapshotDatabase } from "../ops/snapshot.ts";
import type { Readiness } from "../service/readiness.ts";
import { clearPending, writePending, type Pending } from "./pending.ts";
import { checkedId, readCurrent, releaseIsComplete, switchCurrent } from "./releases.ts";

export interface ApplyDeps {
  readonly app: string;
  readonly home: string;
  /** Migration ids the NEW release knows (the running CLI is the new release). */
  readonly knownIds: ReadonlySet<string>;
  readonly systemd: {
    stop(unit: string): Promise<void>;
    restart(unit: string): Promise<void>;
    resetFailed(unit: string): Promise<void>;
    activeState(unit: string): Promise<string | null>;
    restartCount(unit: string): Promise<number | null>;
  };
  /** The journal's `listening` line of the start made at `since`, waiting at most `deadlineMs`; ends early when the unit has failed. */
  listening(since: Date, deadlineMs: number): Promise<Readiness>;
  healthz(): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  freeMb(path: string): number | null;
  /** The instance lock of the home (`acquireInstanceLock`); throws when another process holds it. Returns the release function. */
  holdHome(): () => void;
  readonly deadlineMs: number;
  readonly settleMs: number;
  readonly unit: string;
}

export type ApplyOutcome =
  /** `snapshot` is the file this run took under `backups/`, or null when there was no database. */
  | { kind: "updated"; snapshot: string | null }
  | { kind: "unverified"; snapshot: string | null }
  /** `keptDatabase` is the absolute path of the database the rollback replaced (`backups/pre-rollback-<stamp>.db`), when it restored one. */
  | { kind: "rolled_back"; reason: string; restoredDatabase: boolean; keptDatabase?: string }
  /** `code` is the snapshot primitive's own fixed message when the database step failed. */
  | { kind: "rollback_failed"; reason: string; step: string; code?: string };

export class ApplyRefused extends Error {
  override name = "ApplyRefused";
}

const STAGE_FAILURE: Readonly<Record<string, string>> = {
  stop: "the unit could not be stopped",
  lock: "the home is locked by another pap process",
  snapshot: "the database snapshot or its journal entry could not be written",
  switch: "switching to the new release failed",
  start: "the new release could not be started",
  verify: "the new release could not be verified",
};

/** The fixed `code` of the one database failure that has no snapshot primitive message: the journal never named a snapshot. */
export const NO_SNAPSHOT_CODE =
  "the journal names no snapshot: the database cannot be restored automatically";

const stamp = (at: Date): string => at.toISOString().replace(/[:.]/g, "-");

/** Refuses before anything is touched; every message names the way out. */
export function preflight(
  deps: ApplyDeps,
  to: string,
): { from: string; dbPath: string; ids: string[] | null } {
  try {
    checkedId(to);
  } catch {
    throw new ApplyRefused("invalid release id: nothing was changed");
  }
  const from = readCurrent(deps.app);
  if (from === null) throw new ApplyRefused("no installed release to update from: run the installer instead");
  if (from === to) throw new ApplyRefused(`release ${to} is already the current one`);
  if (!releaseIsComplete(deps.app, to))
    throw new ApplyRefused(`release ${to} is incomplete: nothing was changed`);
  const dbPath = join(deps.home, "state.db");
  let size: number;
  try {
    size = statSync(dbPath).size;
  } catch {
    // no database yet: nothing to snapshot or migrate
    return { from, dbPath, ids: null };
  }
  const ids = schemaIds(dbPath);
  if (ids === null)
    throw new ApplyRefused("the database cannot be read or is damaged: restore a backup first (pap restore)");
  if (ids.some((id) => !deps.knownIds.has(id)))
    throw new ApplyRefused(
      "the database was written by a newer pap than release " +
        to +
        ": a downgrade is refused (pap restore, or pap update rollback)",
    );
  const free = deps.freeMb(deps.home);
  const neededMb = Math.ceil((size * 2) / 1_048_576) + 64;
  if (free !== null && free < neededMb)
    throw new ApplyRefused(`not enough disk space for the snapshot (${neededMb} MB needed, ${free} MB free)`);
  return { from, dbPath, ids };
}

/**
 * The database about to be replaced stays as `backups/pre-rollback-<stamp>.db` (instance lock held): the writes the new
 * release made, possibly for days when the update was cut and `recover` runs later, are then never thrown away. A
 * damaged database cannot be vacuumed and is copied as it is. If it cannot be kept the rollback does not go on.
 */
function keepCurrentDatabase(deps: ApplyDeps, readable: boolean): string | null {
  const source = join(deps.home, "state.db");
  if (!existsSync(source)) return null;
  const kept = join(deps.home, "backups", `pre-rollback-${stamp(deps.now())}.db`);
  if (readable) snapshotDatabase(source, kept, { held: true });
  else copyFileSync(source, kept, constants.COPYFILE_EXCL);
  return kept;
}

/** Everything a rollback needs is in `pending`, so `pap update recover` runs the same code after a crash. Never throws. */
export async function rollback(deps: ApplyDeps, pending: Pending, reason: string): Promise<ApplyOutcome> {
  try {
    return await rollbackSteps(deps, pending, reason);
  } catch {
    return { kind: "rollback_failed", reason, step: "error" };
  }
}

async function rollbackSteps(deps: ApplyDeps, pending: Pending, reason: string): Promise<ApplyOutcome> {
  writePending(deps.home, { ...pending, step: "rolling_back" });
  try {
    await deps.systemd.stop(deps.unit);
  } catch {
    return { kind: "rollback_failed", reason, step: "stop" };
  }
  let release: () => void;
  try {
    release = deps.holdHome();
  } catch {
    return { kind: "rollback_failed", reason, step: "lock" };
  }
  let restoredDatabase = false;
  let keptDatabase: string | null = null;
  try {
    try {
      const before = pending.schemaBefore === null ? null : new Set(pending.schemaBefore);
      if (before !== null) {
        const now = schemaIds(join(deps.home, "state.db"));
        if (now === null || now.some((id) => !before.has(id))) {
          // a migration ran (or the database is damaged): without a snapshot it cannot be undone, and saying
          // "rolled back" would leave the old release on a database it reads read-only
          if (pending.snapshot === null)
            return { kind: "rollback_failed", reason, step: "database", code: NO_SNAPSHOT_CODE };
          keptDatabase = keepCurrentDatabase(deps, now !== null);
          restoreDatabaseFile(join(deps.home, "backups", pending.snapshot), deps.home, before);
          restoredDatabase = true;
        }
      }
    } catch (error) {
      const code = error instanceof SnapshotError ? error.message : undefined;
      return code === undefined
        ? { kind: "rollback_failed", reason, step: "database" }
        : { kind: "rollback_failed", reason, step: "database", code };
    }
    try {
      switchCurrent(deps.app, pending.from);
    } catch {
      return { kind: "rollback_failed", reason, step: "switch" };
    }
  } finally {
    release(); // before the restart: the daemon takes the same lock
  }
  let since: Date;
  try {
    await deps.systemd.resetFailed(deps.unit); // the start limit counts manual starts too
    since = deps.now();
    await deps.systemd.restart(deps.unit);
  } catch {
    return { kind: "rollback_failed", reason, step: "restart" };
  }
  const back = await deps.listening(since, deps.deadlineMs);
  if (back.kind === "never") return { kind: "rollback_failed", reason, step: "old_release_not_listening" };
  if (
    back.kind === "unreadable" &&
    !((await deps.healthz()) && (await deps.systemd.activeState(deps.unit)) === "active")
  )
    return { kind: "rollback_failed", reason, step: "old_release_unverified" }; // no journal proof: health and unit state decide
  clearPending(deps.home);
  return keptDatabase === null
    ? { kind: "rolled_back", reason, restoredDatabase }
    : { kind: "rolled_back", reason, restoredDatabase, keptDatabase };
}

export async function applyRelease(deps: ApplyDeps, to: string): Promise<ApplyOutcome> {
  const { from, dbPath, ids } = preflight(deps, to);
  const startedAt = deps.now();
  let pending: Pending = {
    format: 1,
    from,
    to,
    step: "stopping",
    snapshot: null,
    schemaBefore: ids,
    startedAt: startedAt.toISOString(),
  };
  try {
    writePending(deps.home, pending);
  } catch {
    throw new ApplyRefused("the update journal cannot be written under the home: nothing was changed");
  }
  let failure: string | null = null;
  let unverified = false;
  let stage = "stop";
  try {
    await deps.systemd.stop(deps.unit);
    stage = "lock";
    const release = deps.holdHome(); // after the stop: a daemon started by hand, or a restore, is refused here
    try {
      if (ids !== null) {
        stage = "snapshot";
        const name = `pre-update-${to}-${stamp(startedAt)}.db`;
        snapshotDatabase(dbPath, join(deps.home, "backups", name), { held: true });
        pending = { ...pending, snapshot: name };
        writePending(deps.home, pending); // the journal names the snapshot BEFORE current moves (a kill after the switch)
      }
      stage = "switch";
      switchCurrent(deps.app, to);
      pending = { ...pending, step: "switched" };
      writePending(deps.home, pending);
    } finally {
      release(); // before the restart
    }
    stage = "start";
    await deps.systemd.resetFailed(deps.unit);
    const since = deps.now();
    await deps.systemd.restart(deps.unit);
    pending = { ...pending, step: "started" };
    writePending(deps.home, pending);
    stage = "verify";
    const ready = await deps.listening(since, deps.deadlineMs);
    if (ready.kind === "never") failure = "the new release did not start listening";
    else if (!(await deps.healthz()))
      failure = "the health probe failed"; // also when the journal is unreadable (M6bR12a)
    else {
      const restarts = await deps.systemd.restartCount(deps.unit);
      await deps.sleep(deps.settleMs);
      const state = await deps.systemd.activeState(deps.unit);
      const after = await deps.systemd.restartCount(deps.unit);
      if (restarts === null || after === null) failure = "the restart counter of the unit cannot be read";
      else if (state !== "active" || after !== restarts || !(await deps.healthz()))
        failure = "the new release stopped or restarted during the settle window";
      else unverified = ready.kind === "unreadable"; // installed, every other check passed, the journal cannot confirm (M6 exit 3)
    }
  } catch {
    failure = STAGE_FAILURE[stage] ?? "the update step failed";
  }
  if (failure !== null) return await rollback(deps, pending, failure); // once, outside the try (M6bR18d)
  clearPending(deps.home);
  return { kind: unverified ? "unverified" : "updated", snapshot: pending.snapshot };
}
