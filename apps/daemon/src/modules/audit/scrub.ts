// Each expression has bounded repetition (at most 4 096 characters per part) and no nested quantifier, so a start
// position costs a bounded number of steps. The JWT expression starts only after a character outside its own alphabet:
// with `\b`, a run of `eyJ-` started a 4 096-character scan at every `eyJ` (20 s on 4 MiB). A JWT glued to a
// preceding `-`, `_` or alphanumeric is not matched (M5R124, amended).
const KNOWN_SECRET_FORMATS: ReadonlyArray<readonly [kind: string, pattern: RegExp]> = [
  ["pap_token", /\bpap_[A-Za-z0-9_-]{43}/g],
  ["github_token", /\b(?:gh[opsur]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})/g],
  ["anthropic_key", /\bsk-ant-[A-Za-z0-9_-]{20,255}/g],
  ["api_key", /\bsk-[A-Za-z0-9_-]{20,255}/g],
  ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,255}/g],
  ["jwt", /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}/g],
  ["bearer", /\bbearer[ \t]+[A-Za-z0-9._~+/=-]{20,4096}/gi],
  [
    "private_key",
    /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,8192}?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g,
  ],
];

/** Replaces the well-known secret formats in a worker's text by `[REDACTED:<kind>]` before it is stored for good. */
export function scrubKnownSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const [kind, pattern] of KNOWN_SECRET_FORMATS)
    out = out.replace(pattern, () => {
      count++;
      return `[REDACTED:${kind}]`;
    });
  return { text: out, count };
}

const DETAIL_MAX = 4_000;

/**
 * A session entry's tool names as the audit's `detail`: `{ count, truncated, ...extra, names }`, names cut from the end
 * until the JSON is at most 4 000 characters (the column's CHECK is 4 096). `count` stays the worker's own.
 */
export function fitToolNames(
  names: readonly string[],
  count: number,
  extra: Readonly<Record<string, string>> = {},
): { count: number; truncated: boolean; names: string[] } & Record<string, unknown> {
  const sizes = names.map((name) => JSON.stringify(name).length);
  const frame = (truncated: boolean) => JSON.stringify({ count, truncated, ...extra, names: [] }).length;
  // The frame holds `[]`; each name adds its own length and one comma, and the first has no comma.
  const total = (kept: number, truncated: boolean) => {
    let sum = frame(truncated);
    for (let i = 0; i < kept; i++) sum += (sizes[i] ?? 0) + (i > 0 ? 1 : 0);
    return sum;
  };
  if (total(names.length, false) <= DETAIL_MAX)
    return { count, truncated: false, ...extra, names: [...names] };
  let kept = names.length;
  let sum = total(kept, true);
  while (kept > 0 && sum > DETAIL_MAX) {
    kept--;
    sum -= (sizes[kept] ?? 0) + (kept > 0 ? 1 : 0);
  }
  return { count, truncated: true, ...extra, names: names.slice(0, kept) };
}

const STAGES_MAX = 4_096;
const REASON_LIMITS = [256, 128, 64, 32, 16, 8, 4, 0] as const;

interface Verdict {
  readonly stage: string;
  readonly outcome: string;
  readonly reason?: string | undefined;
}

/**
 * The stage verdicts as the `stages` column holds them (CHECK 4 096 characters, escaped quotes count twice): reasons
 * are clipped, all together, until the JSON fits; ids and outcomes are kept. The daemon's `fact` ends the stage 05
 * reason whatever the clip, so a worker cannot push it out (it is the only part the daemon knows for certain).
 */
export function fitStages<T extends Verdict>(stages: readonly T[], fact?: string): T[] {
  const clipped = (limit: number): T[] =>
    stages.map((verdict) => {
      if (fact !== undefined && verdict.stage === "05") {
        const room = Math.max(0, limit - fact.length - 2);
        const head = (verdict.reason ?? "").slice(0, room);
        return { ...verdict, reason: head ? `${head}; ${fact}` : fact };
      }
      if (verdict.reason === undefined) return verdict;
      if (limit === 0) {
        return Object.fromEntries(
          Object.entries(verdict).filter(([key]) => key !== "reason"),
        ) as unknown as T;
      }
      return { ...verdict, reason: verdict.reason.slice(0, limit) };
    });
  for (const limit of REASON_LIMITS) {
    const fitted = clipped(limit);
    if (JSON.stringify(fitted).length <= STAGES_MAX) return fitted;
  }
  return clipped(0);
}

/** NUL ends a string for SQLite's `length()` and `substr`; every string from a worker loses it before it is stored. */
export function replaceNul<T>(value: T): T {
  if (typeof value === "string") return value.replaceAll("\u0000", "�") as T;
  if (Array.isArray(value)) return value.map((item) => replaceNul(item)) as T;
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceNul(item)])) as T;
  return value;
}
