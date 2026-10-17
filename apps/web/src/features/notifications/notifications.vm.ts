import type { PushConfig, PushDeviceView } from "@pap/contracts";
import type { MessageKey } from "../../i18n/index.ts";
import { cutUnits, stripHidden } from "../../lib/untrusted-text.ts";
import type { PushSupport } from "./support.ts";

type Failure = NonNullable<PushConfig["lastFailure"]>["reason"];

export interface StatusFacts {
  readonly config: PushConfig;
  readonly devices: readonly PushDeviceView[];
  readonly support: PushSupport;
  /** This browser holds a push subscription, with or without a row on the server. */
  readonly browserSubscribed: boolean;
  readonly needsReenable: boolean;
}

export interface StatusView {
  readonly line: { readonly key: MessageKey; readonly tone: "ok" | "off" };
  /** What this browser needs to do before it can subscribe (install, allow, update). */
  readonly notes: readonly MessageKey[];
  readonly hint: string | null;
  readonly keysReset: boolean;
  readonly lastFailure: Failure | null;
  /** Set when the account holds the most devices it may. */
  readonly capacity: { readonly max: number } | null;
  readonly action: "enable" | "disable" | "reenable" | "none";
  readonly actionDisabled: boolean;
  readonly current: PushDeviceView | null;
}

/** Every state of the status block, from contract fields and what the browser says; nothing is guessed (M12R32). */
export function statusView(facts: StatusFacts): StatusView {
  const { config, devices, support } = facts;
  const insecure =
    support === "insecure" ||
    config.reason === "insecure_http" ||
    config.readiness.status === "insecure_http";
  const on = config.status === "on";
  const line: StatusView["line"] = insecure
    ? { key: "push.support.insecure", tone: "off" }
    : on
      ? { key: "notifications.status.on", tone: "ok" }
      : {
          key:
            config.reason === "keys_unreadable"
              ? "notifications.status.off.keys_unreadable"
              : config.reason === "read_only"
                ? "notifications.status.off.read_only"
                : "notifications.status.off",
          tone: "off",
        };
  const notes: MessageKey[] = support === "supported" || insecure ? [] : [`push.support.${support}`];
  const current = devices.find((device) => device.current) ?? null;
  const full = config.max > 0 && config.subscribed >= config.max;
  const canSubscribe = on && support === "supported" && !insecure;
  const stranded = (current === null && facts.browserSubscribed) || facts.needsReenable;
  let action: StatusView["action"];
  let actionDisabled = false;
  if (stranded && canSubscribe) action = "reenable";
  else if (current !== null || facts.browserSubscribed) action = "disable";
  else if (full) action = "none";
  else {
    action = "enable";
    actionDisabled = !canSubscribe;
  }
  return {
    line,
    notes,
    hint: config.readiness.status === "ready" ? null : (config.readiness.hint ?? null),
    keysReset: config.keysReset !== null,
    lastFailure: config.lastFailure?.reason ?? null,
    capacity: full ? { max: config.max } : null,
    action,
    actionDisabled,
    current,
  };
}

export interface DeviceRow {
  readonly id: string;
  /** Empty when the device wrote nothing readable; the view shows a placeholder. */
  readonly label: string;
  readonly host: string;
  readonly createdAt: number;
  readonly lastOkAt: number | null;
  readonly current: boolean;
}

/** A device's own words, as text: hidden characters (bidi, zero-width) are removed, never drawn. */
export function deviceRows(devices: readonly PushDeviceView[]): readonly DeviceRow[] {
  return devices.map((device) => ({
    id: device.id,
    label: cutUnits(stripHidden(device.label), 80).trim(),
    host: cutUnits(stripHidden(device.host), 255),
    createdAt: device.createdAt,
    lastOkAt: device.lastOkAt,
    current: device.current,
  }));
}

export type MutePreset = "off" | "1h" | "8h" | "forever";
/** A stored mute longer than any preset: no preset is selected for it. */
export type MuteChoice = MutePreset | "custom";
const HOUR_MS = 3_600_000;
/** "Until I turn it on": a far-future integer that survives the JSON round trip. */
export const MUTE_FOREVER = Number.MAX_SAFE_INTEGER;

export const muteUntilOf = (preset: MutePreset, now: number): number | null =>
  preset === "off"
    ? null
    : preset === "forever"
      ? MUTE_FOREVER
      : now + (preset === "1h" ? HOUR_MS : 8 * HOUR_MS);

/** The preset a stored `muteUntil` stands for now: an elapsed mute is Off. */
export function mutePreset(muteUntil: number | null, now: number): MuteChoice {
  if (muteUntil === null || muteUntil <= now) return "off";
  if (muteUntil >= MUTE_FOREVER) return "forever";
  if (muteUntil - now > 8 * HOUR_MS) return "custom";
  return muteUntil - now <= HOUR_MS ? "1h" : "8h";
}
