import { ApprovalAnswer } from "@pap/contracts";
import type { Db } from "../kernel/db/database.ts";
import { percentile } from "./percentile.ts";

const FAST_MS = 2_000;

export interface ApprovalsSummary {
  /** Cards shown to someone, in the window. */
  readonly asked: number;
  /** The ones that were answered (a closed session leaves a card asked and never answered). */
  readonly answered: number;
  readonly byAnswer: Readonly<Record<ApprovalAnswer, number>>;
  /** Time to answer, nearest rank (ms); 0 when nothing was answered. */
  readonly medianMs: number;
  readonly p90Ms: number;
  /** The share of answered cards answered in 2 s or less (0..1); 0 when nothing was answered. */
  readonly fastShare: number;
}

interface CardRow {
  answer: ApprovalAnswer | null;
  askedAt: number;
  answeredAt: number | null;
}

/**
 * The approvals of the audit (decision 117, A4): one `call` row per card, written once the question is closed, with
 * when the card was shown, what the owner chose and when. The choice is the owner's, whatever the policy then did.
 */
export function summarizeApprovals(db: Db, options: { now: number; sinceMs?: number }): ApprovalsSummary {
  const oldest = options.sinceMs === undefined ? 0 : options.now - options.sinceMs;
  const rows = db.all<CardRow>(
    "SELECT answer, asked_at AS askedAt, answered_at AS answeredAt FROM audit " +
      "WHERE kind = 'call' AND asked_at IS NOT NULL AND asked_at >= $oldest",
    { oldest },
  );
  const byAnswer = Object.fromEntries(ApprovalAnswer.options.map((answer) => [answer, 0])) as Record<
    ApprovalAnswer,
    number
  >;
  const took: number[] = [];
  for (const row of rows) {
    if (row.answeredAt === null) continue;
    took.push(Math.max(0, row.answeredAt - row.askedAt));
    if (row.answer !== null) byAnswer[row.answer]++;
  }
  took.sort((a, b) => a - b);
  return {
    asked: rows.length,
    answered: took.length,
    byAnswer,
    medianMs: took.length === 0 ? 0 : percentile(took, 50),
    p90Ms: took.length === 0 ? 0 : percentile(took, 90),
    fastShare: took.length === 0 ? 0 : took.filter((ms) => ms <= FAST_MS).length / took.length,
  };
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

export function renderApprovals(summary: ApprovalsSummary): string {
  const { byAnswer } = summary;
  return [
    `approvals: asked ${summary.asked}, answered ${summary.answered}`,
    `by answer: ${ApprovalAnswer.options.map((answer) => `${answer} ${byAnswer[answer]}`).join(", ")}`,
    `time to answer: median ${seconds(summary.medianMs)}, p90 ${seconds(summary.p90Ms)}; ` +
      `answered in 2 s or less: ${Math.round(summary.fastShare * 100)} %`,
  ].join("\n");
}
