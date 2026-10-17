import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { schemaIds } from "../ops/snapshot.ts";
import { readPending, type Pending } from "./pending.ts";
import { checkedId, otherReleases, readCurrent, releaseIsComplete } from "./releases.ts";

export class ManualRollbackRefused extends Error {
  override name = "ManualRollbackRefused";
}

export interface ManualPlan {
  /** The release to go back to. */
  readonly target: string;
  /** The journal `rollback()` runs from: the same shape an interrupted update leaves. */
  readonly pending: Pending;
  /** The database holds a migration the snapshot lacks: the owner chooses `--restore-database` or `--keep-database`. */
  readonly needsDecision: boolean;
  /** The snapshot's time (ISO) when `needsDecision`: writes since then are lost by a restore. */
  readonly lostSince: string | null;
  /** There is a database and no usable snapshot of it: whether the older release can write to it is not known. */
  readonly unknownSchema: boolean;
}

const STAMP = /^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The newest `pre-update-<release>-<stamp>.db` (a regular file); the stamp is a sortable UTC time, so the name decides. */
export function newestSnapshot(home: string, release: string): { name: string; time: string } | null {
  const shape = new RegExp(
    `^pre-update-${escapeRegExp(release)}-(\\d{4}-\\d\\d-\\d\\dT\\d\\d-\\d\\d-\\d\\d-\\d{3}Z)\\.db$`,
  );
  let names: string[];
  try {
    names = readdirSync(join(home, "backups"));
  } catch {
    return null;
  }
  const found = names
    .flatMap((name) => {
      const stamp = shape.exec(name)?.[1];
      const parts = stamp === undefined ? null : STAMP.exec(stamp);
      if (parts === null || parts === undefined) return [];
      try {
        if (!lstatSync(join(home, "backups", name)).isFile()) return [];
      } catch {
        return [];
      }
      return [
        {
          name,
          stamp: stamp as string,
          time: `${parts[1]}T${parts[2]}:${parts[3]}:${parts[4]}.${parts[5]}Z`,
        },
      ];
    })
    .sort((a, b) => (a.stamp < b.stamp ? 1 : -1));
  const newest = found[0];
  return newest === undefined ? null : { name: newest.name, time: newest.time };
}

/**
 * Plans `pap update rollback` (M6bR18, M6bR18b): the target release and the synthetic journal, so that the manual rollback
 * is the same `rollback()` and the same migration rule as an automatic one. Reads only; refuses with a sentence naming the way out.
 */
export function planManualRollback(args: {
  app: string;
  home: string;
  to?: string;
  keepDatabase?: boolean;
  now: Date;
}): ManualPlan {
  const pending = readPending(args.home);
  if (pending !== null)
    throw new ManualRollbackRefused(
      pending === "damaged"
        ? "an update journal (update/pending.json) is damaged: run `pap update recover` first, it says what to check"
        : "an update was interrupted (update/pending.json exists): run `pap update recover` first",
    );
  const current = readCurrent(args.app);
  if (current === null) throw new ManualRollbackRefused("no installed release to roll back from");
  let target: string;
  if (args.to === undefined) {
    const next = otherReleases(args.app, current)[0];
    if (next === undefined)
      throw new ManualRollbackRefused(
        `no other complete release to go back to: ${current} is the only one installed`,
      );
    target = next;
  } else {
    try {
      target = checkedId(args.to);
    } catch {
      throw new ManualRollbackRefused("--to is not a release id (letters, digits, . _ - only)");
    }
    if (target === current) throw new ManualRollbackRefused(`${target} is already the current release`);
    if (!releaseIsComplete(args.app, target))
      throw new ManualRollbackRefused(`release ${target} is incomplete or not installed`);
  }

  const dbPath = join(args.home, "state.db");
  const hasDatabase = existsSync(dbPath);
  const found = hasDatabase ? newestSnapshot(args.home, current) : null;
  const ids = found === null ? null : schemaIds(join(args.home, "backups", found.name));
  // a damaged snapshot counts as none
  const snapshot = found !== null && ids !== null ? { name: found.name, time: found.time, ids } : null;
  let needsDecision = false;
  if (snapshot !== null) {
    const now = schemaIds(dbPath);
    const before = new Set(snapshot.ids);
    // the rule `rollback()` applies: a database that cannot be read, or holds an id the snapshot lacks, is replaced
    needsDecision = now === null || now.some((id) => !before.has(id));
  }
  const restore = snapshot !== null && args.keepDatabase !== true ? snapshot : null;
  return {
    target,
    pending: {
      format: 1,
      from: target,
      to: current,
      step: "rolling_back",
      snapshot: restore?.name ?? null,
      schemaBefore: restore?.ids ?? null,
      startedAt: args.now.toISOString(),
    },
    needsDecision,
    lostSince: needsDecision ? (snapshot?.time ?? null) : null,
    unknownSchema: hasDatabase && snapshot === null,
  };
}
