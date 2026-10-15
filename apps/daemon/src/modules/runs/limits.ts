/** How much of a run's error text is read (M10R103). */
const READ_CHARS = 2048;
const MAX_AHEAD_MS = 7 * 86_400_000;
const MINUTE_MS = 60_000;

// Pi's own non-retryable limit words, and a final rate limit (Pi retried and gave up). Plain alternatives: linear.
const LIMIT_WORDS = new RegExp(
  [
    "usage[ _]limit",
    "usage_not_included",
    "GoUsageLimitError",
    "FreeUsageLimitError",
    "insufficient_quota",
    "quota exceeded",
    "out of budget",
    "available balance",
    "subscription_sharing_usage_limit_exceeded",
    "rate[ _]limit",
  ].join("|"),
  "i",
);

// Bounded digit runs and single optional groups: no nested quantifier, so no backtracking blow-up.
const IN_MINUTES = /try again in ~?\s?(\d{1,6})\s?min/i;
const IN_SECONDS = /(?:try again|retry) (?:in|after) ~?(\d{1,8})\s?s(?:ec(?:ond)?s?)?\b/i;
const RESETS_IN = /resets? in (?:(\d{1,5})\s?h(?:ours?)?)?\s?(?:(\d{1,6})\s?m(?:in(?:ute)?s?)?)?/i;
const RESETS_AT = /resets? (?:at|on) (\d{4}-\d{2}-\d{2}T[0-9:.]{1,16}(?:Z|[+-]\d{2}:?\d{2}))/i;

export type LimitVerdict =
  { readonly kind: "limited"; readonly resetAt: number | null } | { readonly kind: "failed" };

function delayOf(text: string): number | null {
  const minutes = IN_MINUTES.exec(text);
  if (minutes) return Number(minutes[1]) * MINUTE_MS;
  const seconds = IN_SECONDS.exec(text);
  if (seconds) return Number(seconds[1]) * 1000;
  const resets = RESETS_IN.exec(text);
  if (resets && (resets[1] !== undefined || resets[2] !== undefined))
    return (Number(resets[1] ?? 0) * 60 + Number(resets[2] ?? 0)) * MINUTE_MS;
  return null;
}

/** The instant the limit lifts, if the text says one within the next 7 days; a past or farther one is none. */
function resetOf(text: string, now: number): number | null {
  const delay = delayOf(text);
  const at = delay !== null ? now + delay : Date.parse(RESETS_AT.exec(text)?.[1] ?? "");
  return Number.isFinite(at) && at > now && at <= now + MAX_AHEAD_MS ? at : null;
}

/**
 * Whether a run that ended in `stopReason` is a quota limit and when it lifts (M10R103). Pure. Only a run whose last
 * stop reason is `error` can be limited; anything else that reads as a provider error stays a plain failure.
 */
export function classifyLimit(
  stopReason: string | null,
  errorText: string | null,
  now: number,
): LimitVerdict {
  if (stopReason !== "error" || errorText === null) return { kind: "failed" };
  const text = errorText.slice(0, READ_CHARS);
  if (!LIMIT_WORDS.test(text)) return { kind: "failed" };
  return { kind: "limited", resetAt: resetOf(text, now) };
}
