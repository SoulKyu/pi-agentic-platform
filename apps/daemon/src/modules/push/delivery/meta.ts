import type { PushClass } from "@pap/contracts";

/** The numbers of the delivery rules (M12R3, M12R9, M12R11); one place so the tests and the handlers agree. */
export const DELIVERY = {
  /** An approval waits this long before its first send, so a quick answer never pushes (M12R1). */
  approvalDelayMs: 60_000,
  /** A focused device defers an approval's send by this long, at most `maxRechecks` times (M12R3). */
  recheckMs: 60_000,
  maxRechecks: 3,
  cooldownMs: 5_000,
  cooldownKeys: 256,
  hourlyCap: 20,
  hourMs: 3_600_000,
  presenceKeys: 64,
  nameMax: 60,
} as const;

/** A registry name made safe for a lock screen: no controls, format, line or paragraph separators; 60 code points. */
export function clipName(name: string): string {
  const stripped = name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").trim();
  return Array.from(stripped).slice(0, DELIVERY.nameMax).join("");
}

/** What an event can be: a class the owner toggles, or a wire-only one. */
export type EventClass = PushClass | "digest" | "test";

/** The event's own key, unique only while the event is live. The outbox key is `push.send:<id>`, never this (M12R1). */
export const eventKey = (cls: string, refKind: string, refId: string): string =>
  `push:${cls}:${refKind}:${refId}`;
