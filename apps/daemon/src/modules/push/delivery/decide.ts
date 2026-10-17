import type { NotificationsSettings, PushClass } from "@pap/contracts";
import { DELIVERY, type EventClass } from "./meta.ts";

export type Decision =
  | { action: "send" }
  | { action: "suppress"; reason: "class_off" | "muted" | "focused" | "cooldown" | "rate_cap" }
  | { action: "hold" }
  | { action: "recheck"; afterMs: 60_000 };

export interface DecideInput {
  readonly cls: EventClass;
  readonly now: number;
  readonly settings: NotificationsSettings;
  readonly quiet: boolean;
  readonly looking: boolean;
  readonly cooldownFree: boolean;
  /** The owner's `sent` non-approval events of the last hour, read from the table. */
  readonly hourCount: number;
  readonly rechecks: number;
}

/**
 * The delivery order of M12R3, pure. A `digest` skips the class toggles, the cooldown, the cap and quiet hours but not
 * mute or focus (M12R17); a `test` push is the owner pressing a button and skips everything.
 */
export function decide(input: DecideInput): Decision {
  const { cls, settings } = input;
  if (cls === "test") return { action: "send" };
  const isDigest = cls === "digest";
  if (!isDigest && !settings.classes[cls as PushClass]) return { action: "suppress", reason: "class_off" };
  if (settings.muteUntil !== null && settings.muteUntil > input.now)
    return { action: "suppress", reason: "muted" };
  if (input.looking) {
    if (cls === "approval")
      return input.rechecks < DELIVERY.maxRechecks
        ? { action: "recheck", afterMs: DELIVERY.recheckMs }
        : { action: "suppress", reason: "focused" };
    return { action: "suppress", reason: "focused" };
  }
  if (isDigest) return { action: "send" };
  if (!input.cooldownFree) return { action: "suppress", reason: "cooldown" };
  if (cls !== "approval" && input.hourCount >= DELIVERY.hourlyCap)
    return { action: "suppress", reason: "rate_cap" };
  return input.quiet ? { action: "hold" } : { action: "send" };
}
