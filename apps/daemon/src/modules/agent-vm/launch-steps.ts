import type { LaunchStep } from "@pap/contracts";
import type { Db } from "../../kernel/db/database.ts";

/** How many runs of a step a box keeps, and the fewest that make a "usual". */
export const KEPT_RUNS = 20;
export const MIN_SAMPLES = 3;

export interface LaunchStepStore {
  /** A step that ended well, `ms` long. */
  record(boxKey: string, step: LaunchStep, ms: number, at: number): void;
  /** The median of the box's last runs of the step; null below three. */
  usualMs(boxKey: string, step: LaunchStep): number | null;
}

/** `launch_steps` (migration `202610251200`): the insert and the trim to the last 20 per box and step are one transaction. */
export function createLaunchStepStore(db: Db): LaunchStepStore {
  return {
    record(boxKey, step, ms, at) {
      if (db.readOnly) return;
      db.transaction(() => {
        db.run("INSERT INTO launch_steps (box_key, step, ms, at) VALUES (:boxKey, :step, :ms, :at)", {
          boxKey,
          step,
          ms: Math.max(0, Math.round(ms)),
          at,
        });
        db.run(
          `DELETE FROM launch_steps WHERE box_key = :boxKey AND step = :step AND rowid NOT IN
             (SELECT rowid FROM launch_steps WHERE box_key = :boxKey AND step = :step ORDER BY at DESC, rowid DESC LIMIT :kept)`,
          { boxKey, step, kept: KEPT_RUNS },
        );
      });
    },
    usualMs(boxKey, step) {
      const rows = db.all<{ ms: number }>(
        "SELECT ms FROM launch_steps WHERE box_key = :boxKey AND step = :step ORDER BY at DESC, rowid DESC LIMIT :kept",
        { boxKey, step, kept: KEPT_RUNS },
      );
      if (rows.length < MIN_SAMPLES) return null;
      const sorted = rows.map((row) => row.ms).sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 1
        ? (sorted[middle] as number)
        : Math.round(((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2);
    },
  };
}
