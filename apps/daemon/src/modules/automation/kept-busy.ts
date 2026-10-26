import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { Settlement } from "../../kernel/outbox/index.ts";
import type { PutOff } from "./put-off.ts";
import type { TaskRow } from "./tasks.ts";

/** A kept disk that a VM still holds is looked at again after this. */
export const KEPT_BUSY_MS = 30_000;
/** Tasks remembered as already said (a bound: the oldest are forgotten, and said once more at worst). */
const SAID_MAX = 1_000;

/**
 * A kept task whose start pap-vmd refused `conflict` (the previous run's VM still holds the disk, K2): the task waits 30 s,
 * with no attempt and no failure, and the first time it is said in the log (task id only, no trigger text).
 */
export function createKeptBusy(deps: {
  readonly clock: Pick<Clock, "now">;
  readonly logger: Logger;
  readonly putOff: Map<string, PutOff>;
}) {
  const said = new Set<string>();
  return (row: TaskRow): Settlement => {
    if (!said.has(row.id)) {
      if (said.size >= SAID_MAX) said.clear();
      said.add(row.id);
      deps.logger.info("kept_disk_busy", { taskId: row.id });
    }
    const until = deps.clock.now() + KEPT_BUSY_MS;
    // No reason of its own: the closest the board has is a resource wait.
    deps.putOff.set(row.id, { until, reason: "session_slots" });
    return { outcome: "defer", until };
  };
}
