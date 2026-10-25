import type { Clock } from "../../kernel/clock.ts";
import type { Settlement } from "../../kernel/outbox/index.ts";
import type { Admission } from "./admit.ts";
import type { PutOff } from "./put-off.ts";
import { CAPACITY_MS, done } from "./runner-start.ts";
import type { TaskStore } from "./tasks.ts";

const SLOTS_FULL_MS = 10_000;
/** The most queued tasks of an owner told what they wait for in one look. */
const WAIT_SAID_MAX = 100;

/**
 * What a `task.start` answers when the admission picked nobody (M10R36). Full slots are said on the owner's queued tasks
 * (`session_slots`, with the count in use and the limit) and the effect looks again soon. A defer spends no attempt.
 */
export function deferNone(
  deps: {
    readonly clock: Clock;
    readonly store: Pick<TaskStore, "queuedIds">;
    readonly putOff: Map<string, PutOff>;
  },
  picked: Extract<Admission, { kind: "none" }>,
): Settlement {
  if (picked.reason === "empty") return done;
  const until = deps.clock.now() + (picked.reason === "slots" ? SLOTS_FULL_MS : CAPACITY_MS);
  for (const { ownerId, used, max } of picked.full ?? [])
    for (const id of deps.store.queuedIds(ownerId, WAIT_SAID_MAX))
      deps.putOff.set(id, { until, reason: "session_slots", used, max, passive: true });
  return { outcome: "defer", until };
}
