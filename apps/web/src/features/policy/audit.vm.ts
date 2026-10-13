import type { AuditView, StageVerdict } from "@pap/contracts";
import type { ChipTone } from "@pap/ui";
import { plain } from "./policy-settings.vm.ts";

export const REASON_POINTS = 200;
export const ARGS_POINTS = 300;
export const NAMES_POINTS = 300;
/** The list never grows past this many rows; the owner narrows by session instead. */
export const MAX_ROWS = 1000;
const MODE_POINTS = 32;
const NAME_POINTS = 80;

/** "01 pass · 02 skip · 03 ask": the trail only; each verdict's reason is shown apart, in the row's details. */
export const stageLine = (stages: readonly StageVerdict[]): string =>
  stages.map((verdict) => `${verdict.stage} ${verdict.outcome}`).join(" · ");

const toneOf: Record<AuditView["decision"], ChipTone> = {
  allow: "ok",
  approved: "ok",
  denied: "att",
  block: "err",
  info: "mut",
};
export const decisionTone = (decision: AuditView["decision"]): ChipTone => toneOf[decision];

export interface Clipped {
  /** Stripped, then cut at `max` code points with an ellipsis. */
  readonly text: string;
  readonly clipped: boolean;
  /** Stripped, not cut: what the expand shows. */
  readonly full: string;
}

/** Text from a worker or a model: invisible controls out first, then cut by code points (never in a surrogate pair). */
export function clipPoints(raw: string, max: number): Clipped {
  const full = plain(raw);
  const points = [...full];
  return points.length > max
    ? { text: `${points.slice(0, max).join("")}…`, clipped: true, full }
    : { text: full, clipped: false, full };
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export interface SessionDetail {
  /** Null on a row written before the mode was recorded. */
  readonly mode: string | null;
  readonly names: string[];
  readonly count: number;
  readonly truncated: boolean;
}

export function sessionDetail(detail: unknown): SessionDetail {
  const raw = record(detail);
  const names = Array.isArray(raw["names"])
    ? raw["names"].filter((name): name is string => typeof name === "string")
    : [];
  return {
    mode: typeof raw["mode"] === "string" ? clipPoints(raw["mode"], MODE_POINTS).text : null,
    names: names.map((name) => clipPoints(name, NAME_POINTS).text),
    count: typeof raw["count"] === "number" && Number.isFinite(raw["count"]) ? raw["count"] : 0,
    truncated: raw["truncated"] === true,
  };
}

export function resultDetail(detail: unknown): { redactions: number; external: boolean } {
  const raw = record(detail);
  const redactions = raw["redactions"];
  return {
    redactions: typeof redactions === "number" && Number.isFinite(redactions) ? redactions : 0,
    external: raw["external"] === true,
  };
}

/** The daemon writes this marker where a session's worker rows were dropped by the rate limit. */
export const isGap = (row: AuditView): boolean =>
  row.kind === "audit" && row.reason === "audit rows dropped: rate limit";

export function timeOf(millis: number, locale: string): string {
  return Number.isFinite(millis) && Math.abs(millis) <= 8.64e15
    ? new Date(millis).toLocaleString(locale)
    : "";
}
