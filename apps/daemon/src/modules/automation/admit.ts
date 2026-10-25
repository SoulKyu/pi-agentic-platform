import type { AutomationSettings } from "@pap/contracts";
import type { PutOff } from "./put-off.ts";
import type { TaskRow, TaskStore } from "./tasks.ts";

export type Admission =
  | { readonly kind: "task"; readonly task: TaskRow }
  /** `paused` and `slots` hold queued tasks back; `empty` means there is nothing to start. */
  | {
      readonly kind: "none";
      readonly reason: "empty" | "paused" | "slots" | "capacity";
      /** For `slots`: the owners whose slots are full, with the count in use and the limit. */
      readonly full?: readonly { readonly ownerId: string; readonly used: number; readonly max: number }[];
    };

export interface AdmissionDeps {
  readonly store: TaskStore;
  readonly settings: { automation(ownerId: string): AutomationSettings };
  /** The tasks whose start is in flight, by owner: each counts as a slot and is never picked again. */
  readonly starting: ReadonlyMap<string, string>;
  /** Tasks put off until a time (no worker was free): not picked again before it, so the others get their turn. */
  readonly putOff: Map<string, PutOff>;
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
      const full: { ownerId: string; used: number; max: number }[] = [];
      const now = deps.now();
      // A passive entry is kept (and said again) while its owner is full, and dropped when it is not.
      for (const [id, entry] of deps.putOff)
        if (entry.until <= now && entry.passive !== true) deps.putOff.delete(id);
      const eligible: string[] = [];
      for (const ownerId of deps.store.queuedOwners()) {
        const settings = deps.settings.automation(ownerId);
        if (settings.paused) {
          blocked ??= "paused";
          continue;
        }
        const starting = [...deps.starting.values()].filter((owner) => owner === ownerId).length;
        const used = deps.store.counts(ownerId).running + starting;
        if (used >= settings.slots) {
          blocked = "slots";
          full.push({ ownerId, used, max: settings.slots });
          continue;
        }
        for (const id of deps.store.queuedIds(ownerId, 100))
          if (deps.putOff.get(id)?.passive) deps.putOff.delete(id);
        eligible.push(ownerId);
      }
      // A task held for slots (passive) is only said so: the owner's slots hold it back, and a free one starts it at once.
      const off = [...deps.putOff].filter(([, entry]) => entry.passive !== true);
      const excluded = [...deps.starting.keys(), ...off.map(([id]) => id)];
      const task = eligible.length > 0 ? deps.store.nextQueued(eligible, excluded, now) : undefined;
      if (task) return { kind: "task", task };
      if (blocked === null && off.length > 0 && eligible.length > 0)
        return { kind: "none", reason: "capacity" };
      return blocked === "slots"
        ? { kind: "none", reason: "slots", full }
        : { kind: "none", reason: blocked ?? "empty" };
    },
  };
}
