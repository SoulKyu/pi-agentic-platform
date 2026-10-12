// Each expression has bounded repetition and no nested quantifier: linear on any text (M5R124).
const KNOWN_SECRET_FORMATS: ReadonlyArray<readonly [kind: string, pattern: RegExp]> = [
  ["pap_token", /\bpap_[A-Za-z0-9_-]{43}/g],
  ["github_token", /\b(?:gh[opsur]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})/g],
  ["anthropic_key", /\bsk-ant-[A-Za-z0-9_-]{20,255}/g],
  ["api_key", /\bsk-[A-Za-z0-9_-]{20,255}/g],
  ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,255}/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}/g],
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
 * A session entry's tool names as the audit's `detail`: names are cut from the end until the JSON is at most 4 000
 * characters (the column's CHECK is 4 096). `count` stays the worker's own.
 */
export function fitToolNames(
  names: readonly string[],
  count: number,
): { count: number; truncated: boolean; names: string[] } {
  const kept = [...names];
  const whole = { count, truncated: false, names: kept };
  if (JSON.stringify(whole).length <= DETAIL_MAX) return whole;
  while (kept.length > 0 && JSON.stringify({ count, truncated: true, names: kept }).length > DETAIL_MAX)
    kept.pop();
  return { count, truncated: true, names: kept };
}
