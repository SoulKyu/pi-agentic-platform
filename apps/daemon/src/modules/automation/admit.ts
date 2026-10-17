import type { AutomationSettings } from "@pap/contracts";
import type { TaskRow, TaskStore } from "./tasks.ts";

export type Admission =
  | { readonly kind: "task"; readonly task: TaskRow }
  /** `paused` and `slots` hold queued tasks back; `empty` means there is nothing to start. */
  | { readonly kind: "none"; readonly reason: "empty" | "paused" | "slots" | "capacity" };

export interface AdmissionDeps {
  readonly store: TaskStore;
  readonly settings: { automation(ownerId: string): AutomationSettings };
  /** The tasks whose start is in flight, by owner: each counts as a slot and is never picked again. */
  readonly starting: ReadonlyMap<string, string>;
  /** Tasks put off until a time (no worker was free): not picked again before it, so the others get their turn. */
  readonly putOff: Map<string, number>;
  now(): number;
}

/**
 * Who starts next (M10R36). Slots are per owner: `running + starting < slots`, a paused owner starts nothing. Among an
 * owner's queued tasks the trigger that started longest ago goes first, so a noisy trigger cannot starve the others
 * (RT-10). A `limited` task holds no slot. Reads only: the caller adds the pick to the starting set in the same tick.
 */
export function createAdmission(deps: AdmissionDeps) {
  return {
    pick(): Admission {
      let blocked: "paused" | "slots" | null = null;
      const now = deps.now();
      for (const [id, until] of deps.putOff) if (until <= now) deps.putOff.delete(id);
      const eligible: string[] = [];
      for (const ownerId of deps.store.queuedOwners()) {
        const settings = deps.settings.automation(ownerId);
        if (settings.paused) {
          blocked ??= "paused";
          continue;
        }
        const starting = [...deps.starting.values()].filter((owner) => owner === ownerId).length;
        if (deps.store.counts(ownerId).running + starting >= settings.slots) {
          blocked = "slots";
          continue;
        }
        eligible.push(ownerId);
      }
      const excluded = [...deps.starting.keys(), ...deps.putOff.keys()];
      const task = eligible.length > 0 ? deps.store.nextQueued(eligible, excluded, now) : undefined;
      if (task) return { kind: "task", task };
      if (blocked === null && deps.putOff.size > 0 && eligible.length > 0)
        return { kind: "none", reason: "capacity" };
      return { kind: "none", reason: blocked ?? "empty" };
    },
  };
}
