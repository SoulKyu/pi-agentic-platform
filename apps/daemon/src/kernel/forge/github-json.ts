import type { IssueView, PrView } from "@pap/contracts";
import { z } from "zod";

const Check = z.looseObject({
  status: z.string().max(32).nullable().optional(),
  conclusion: z.string().max(32).nullable().optional(),
  state: z.string().max(32).nullable().optional(),
});
const State = z.enum(["OPEN", "CLOSED", "MERGED"]);
export const GhPr = z.looseObject({
  number: z.number().int().positive(),
  url: z.string().max(2048),
  state: State,
  isDraft: z.boolean(),
  mergeable: z.string().max(32).optional(),
  statusCheckRollup: z.array(Check).max(1000).optional(),
});
/**
 * `gh pr list --head` matches the branch name across forks, so the lane's own pull request can sit behind any number
 * of newer fork ones; a list that fills the limit without one of the repository's own is inconclusive (Task 14).
 */
export const FIND_LIMIT = 100;
export const GhPrList = z
  .array(
    z.looseObject({
      number: z.number().int().positive(),
      url: z.string().max(2048),
      state: State,
      isDraft: z.boolean(),
      isCrossRepository: z.boolean(),
    }),
  )
  .max(FIND_LIMIT);
export const GhIssue = z.looseObject({
  number: z.number().int().positive(),
  title: z.string().max(100_000),
  body: z.string().max(10_000_000),
  state: z.string().max(32),
  labels: z.array(z.looseObject({ name: z.string().max(10_000) })).max(1000),
  url: z.string().max(2048),
});

const PASSED: ReadonlySet<string> = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILED: ReadonlySet<string> = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "ERROR",
  "STARTUP_FAILURE",
]);

export function checksOf(rollup: z.infer<typeof Check>[] | undefined) {
  const counts = { total: 0, passed: 0, failed: 0, pending: 0 };
  for (const check of rollup ?? []) {
    counts.total += 1;
    const verdict = check.conclusion ?? check.state ?? null;
    if (verdict !== null && PASSED.has(verdict)) counts.passed += 1;
    else if (verdict !== null && FAILED.has(verdict)) counts.failed += 1;
    else counts.pending += 1;
  }
  return counts;
}

const TITLE_MAX = 256;
const BODY_MAX = 20_000;
const LABELS_MAX = 20;
const LABEL_MAX = 64;
/**
 * Issue text is read by the model: NUL (the contract refuses it), format characters (bidi controls, zero width,
 * Unicode tags), C0/C1 controls, variation selectors U+E0100-E01EF and the line and paragraph separators U+2028/2029
 * go; newline and tab stay. The prompt builder cleans a token-supplied issue the same way.
 */
export const cleanIssueText = (text: string): string =>
  text.replace(/[\p{Cf}\p{Cc}\u{E0100}-\u{E01EF}\u2028\u2029]/gu, (char) =>
    char === "\n" || char === "\t" ? char : "",
  );
const clean = cleanIssueText;

const STATES = { OPEN: "open", CLOSED: "closed", MERGED: "merged" } as const;
const CONFLICTS: Readonly<Record<string, boolean>> = { CONFLICTING: true, MERGEABLE: false };

export function prViewOf(pr: z.infer<typeof GhPr>, checkedAt: number): PrView {
  return {
    number: pr.number,
    url: pr.url,
    state: STATES[pr.state],
    draft: pr.isDraft,
    conflicts:
      pr.mergeable !== undefined && Object.hasOwn(CONFLICTS, pr.mergeable)
        ? (CONFLICTS[pr.mergeable] as boolean)
        : null,
    checks: pr.statusCheckRollup === undefined ? null : checksOf(pr.statusCheckRollup),
    checkedAt,
    error: null,
  };
}

export function issueViewOf(issue: z.infer<typeof GhIssue>): IssueView {
  const title = clean(issue.title);
  const body = clean(issue.body);
  return {
    forge: "github",
    url: issue.url,
    number: issue.number,
    title: title.slice(0, TITLE_MAX),
    body: body.slice(0, BODY_MAX),
    state: issue.state,
    labels: issue.labels.slice(0, LABELS_MAX).map((label) => clean(label.name).slice(0, LABEL_MAX)),
    truncated: title.length > TITLE_MAX || body.length > BODY_MAX || issue.labels.length > LABELS_MAX,
  };
}
