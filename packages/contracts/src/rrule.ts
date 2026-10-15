/**
 * The schedule subset of RRULE (M10R59); its next occurrence is in `rrule-next.ts` (M10R60). Pure: no clock, no I/O.
 * `Rrule` is already the name of the bounded-shape schema in `automation.ts`, so the parsed rule is `ParsedRrule`.
 */

export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

export type ParsedRrule =
  | { readonly freq: "MINUTELY"; readonly interval: number }
  | { readonly freq: "HOURLY"; readonly interval: number; readonly minutes: readonly number[] }
  | { readonly freq: "DAILY"; readonly hours: readonly number[]; readonly minute: number }
  | {
      readonly freq: "WEEKLY";
      /** 0 = Monday … 6 = Sunday. */
      readonly days: readonly number[];
      readonly hours: readonly number[];
      readonly minute: number;
    };

export type RruleReason = "rrule_unsupported" | "rrule_value";
export type RruleParse = { ok: true; rule: ParsedRrule } | { ok: false; reason: RruleReason };

const ALLOWED_KEYS: Record<string, readonly string[]> = {
  MINUTELY: ["FREQ", "INTERVAL"],
  HOURLY: ["FREQ", "INTERVAL", "BYMINUTE"],
  DAILY: ["FREQ", "BYHOUR", "BYMINUTE"],
  WEEKLY: ["FREQ", "BYDAY", "BYHOUR", "BYMINUTE"],
};
const MAX_HOURLY_MINUTES = 12;

class Refusal extends Error {
  readonly reason: RruleReason;
  constructor(reason: RruleReason) {
    super(reason);
    this.reason = reason;
  }
}
const refuse = (reason: RruleReason): never => {
  throw new Refusal(reason);
};

/** A list of distinct whole numbers inside the range, ascending. */
function numbers(text: string, min: number, max: number, limit: number): number[] {
  const parts = text.split(",");
  if (parts.length > limit) return refuse("rrule_value");
  const values = parts.map((part) => (/^\d{1,4}$/.test(part) ? Number(part) : refuse("rrule_value")));
  if (values.some((value) => value < min || value > max)) return refuse("rrule_value");
  if (new Set(values).size !== values.length) return refuse("rrule_value");
  return values.sort((a, b) => a - b);
}

function days(text: string): number[] {
  const values = text.split(",").map((part) => {
    const index = (WEEKDAYS as readonly string[]).indexOf(part);
    return index === -1 ? refuse("rrule_value") : index;
  });
  if (new Set(values).size !== values.length) return refuse("rrule_value");
  return values.sort((a, b) => a - b);
}

function build(fields: Map<string, string>): ParsedRrule {
  const need = (key: string): string => fields.get(key) ?? refuse("rrule_value");
  const freq = fields.get("FREQ");
  if (freq === undefined || !Object.hasOwn(ALLOWED_KEYS, freq)) return refuse("rrule_unsupported");
  const allowed = ALLOWED_KEYS[freq] as readonly string[];
  for (const key of fields.keys()) if (!allowed.includes(key)) refuse("rrule_unsupported");
  const single = (): number => {
    const text = fields.get("BYMINUTE");
    return text === undefined ? 0 : (numbers(text, 0, 59, 1)[0] as number);
  };
  switch (freq) {
    case "MINUTELY":
      return { freq, interval: numbers(need("INTERVAL"), 5, 1440, 1)[0] as number };
    case "HOURLY": {
      const interval = fields.has("INTERVAL") ? (numbers(need("INTERVAL"), 1, 24, 1)[0] as number) : 1;
      const minutes = fields.has("BYMINUTE") ? numbers(need("BYMINUTE"), 0, 59, MAX_HOURLY_MINUTES) : [0];
      return { freq, interval, minutes };
    }
    case "DAILY":
      return { freq, hours: numbers(need("BYHOUR"), 0, 23, 24), minute: single() };
    default:
      return {
        freq: "WEEKLY",
        days: days(need("BYDAY")),
        hours: numbers(need("BYHOUR"), 0, 23, 24),
        minute: single(),
      };
  }
}

export function parseRrule(text: string): RruleParse {
  try {
    const fields = new Map<string, string>();
    for (const pair of text.split(";")) {
      const at = pair.indexOf("=");
      if (at <= 0) return { ok: false, reason: "rrule_unsupported" };
      const key = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (fields.has(key)) return { ok: false, reason: "rrule_value" };
      if (value === "") return { ok: false, reason: "rrule_value" };
      fields.set(key, value);
    }
    return { ok: true, rule: build(fields) };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.reason };
    throw error;
  }
}

export const isSupportedRrule = (text: string): boolean => parseRrule(text).ok;
