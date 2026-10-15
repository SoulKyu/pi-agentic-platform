import type { WEBHOOK_FORMATS } from "@pap/contracts";

export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

export interface MappedPayload {
  /** What the model reads (fenced by the caller): one line per alert, or the text as sent. */
  readonly text: string;
  /** The alert group's identity, the dedup key's source; null when the body itself is the key. */
  readonly identity: string | null;
  /** The task's one-line summary: the first line, without hidden characters. */
  readonly detail: string;
  readonly allResolved: boolean;
}

/** Bounds on what an attacker-controlled body can make the mapping read or build (M10R56). */
export const PAYLOAD_LIMITS = {
  alertLines: 50,
  lineChars: 512,
  fieldChars: 200,
  identityAlerts: 1_000,
  labelKeys: 64,
  fingerprintChars: 128,
  detailChars: 120,
} as const;

// Line breaks and other controls become a space; bidi and zero-width format characters are dropped.
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;
const FORMAT = /\p{Cf}+/gu;
// The raw text keeps its line breaks and tabs; every other control and every format character (bidi, zero-width, tags) goes.
const RAW_HIDDEN = /\p{Cf}+|(?:(?![\t\n])\p{Cc})+/gu;

/** A string of the body as one visible line of at most `max` characters; anything that is not a string is "". */
function line(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const bounded = value.length > max * 4 ? value.slice(0, max * 4) : value;
  const clean = bounded.replace(FORMAT, "").replace(BREAKS, " ").replace(/ {2,}/g, " ").trim();
  return [...clean].slice(0, max).join("");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The labels as sorted `key=value` JSON: string values only, at most 64 keys, so no nesting is ever walked. */
function labelsKey(labels: unknown): string {
  if (!isRecord(labels)) return "{}";
  const keys = Object.keys(labels).sort().slice(0, PAYLOAD_LIMITS.labelKeys);
  const picked: Record<string, string> = {};
  for (const key of keys)
    picked[line(key, PAYLOAD_LIMITS.fieldChars)] = line(labels[key], PAYLOAD_LIMITS.fieldChars);
  return JSON.stringify(picked);
}

const clipLine = (text: string): string => [...text].slice(0, PAYLOAD_LIMITS.lineChars).join("");

function alertLine(alert: Record<string, unknown>, groupStatus: string): string {
  const labels = isRecord(alert.labels) ? alert.labels : {};
  const notes = isRecord(alert.annotations) ? alert.annotations : {};
  const field = (value: unknown) => line(value, PAYLOAD_LIMITS.fieldChars);
  const head = [
    field(alert.status) || groupStatus,
    field(labels.severity),
    field(labels.alertname),
    field(labels.instance),
  ]
    .filter((part) => part !== "")
    .join(" ");
  const note = field(notes.summary) || field(notes.description);
  return clipLine(note === "" ? head : `${head}: ${note}`);
}

function asRaw(body: unknown, text: string): MappedPayload {
  const own = (isRecord(body) && typeof body.text === "string" ? body.text : text).replace(RAW_HIDDEN, "");
  const first = own.split(/\r\n|[\n\r\u2028\u2029]/, 1)[0];
  return { text: own, identity: null, detail: line(first, PAYLOAD_LIMITS.detailChars), allResolved: false };
}

/**
 * Turns a delivery into the text the model reads and the identity that dedups it. `body` is the parsed JSON (undefined
 * for a text body); `text` the decoded body. Only the fields named here are read, each clipped before use: a nested or
 * huge body costs no more than a small one, and nothing the body says is ever evaluated.
 */
export function mapPayload(format: WebhookFormat, body: unknown, text: string): MappedPayload {
  if (format === "raw" || !isRecord(body) || !Array.isArray(body.alerts)) return asRaw(body, text);
  const alerts = (body.alerts as unknown[]).filter(isRecord);
  if (alerts.length === 0) return asRaw(body, text);

  const statusOf = (alert: Record<string, unknown>): string =>
    line(alert.status, 32) || line(body.status, 32);
  const allResolved = alerts.every((alert) => statusOf(alert) === "resolved");
  const groupStatus = line(body.status, 32) || (allResolved ? "resolved" : "firing");
  const lines = alerts.slice(0, PAYLOAD_LIMITS.alertLines).map((alert) => alertLine(alert, groupStatus));
  const more = alerts.length - lines.length;
  if (more > 0) lines.push(`… and ${more} more`);

  const fingerprints = alerts
    .slice(0, PAYLOAD_LIMITS.identityAlerts)
    .map((alert) => line(alert.fingerprint, PAYLOAD_LIMITS.fingerprintChars) || labelsKey(alert.labels))
    .sort();
  return {
    text: lines.join("\n"),
    identity: `${groupStatus}:${fingerprints.join(",")}`,
    detail: line(lines[0], PAYLOAD_LIMITS.detailChars),
    allResolved,
  };
}
