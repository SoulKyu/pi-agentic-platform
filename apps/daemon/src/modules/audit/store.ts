import { ApprovalAnswer, type AuditView, STAGE_IDS, StageVerdict } from "@pap/contracts";
import { z } from "zod";
import type { Db } from "../../kernel/db/database.ts";

export interface AuditRow extends AuditView {
  readonly ownerId: string | null;
}

export interface AuditInsert {
  readonly at: number;
  readonly ownerId: string | null;
  readonly actor: AuditView["actor"];
  readonly actorId?: string | undefined;
  readonly kind: AuditView["kind"];
  readonly sessionId?: string | undefined;
  readonly toolCallId?: string | undefined;
  readonly parentToolCallId?: string | undefined;
  readonly tool?: string | undefined;
  readonly category?: string | undefined;
  readonly decision: AuditView["decision"];
  readonly reason?: string | undefined;
  readonly stages?: readonly StageVerdict[] | undefined;
  readonly args?: string | undefined;
  readonly detail?: Record<string, unknown> | undefined;
  /** A call that asked (decision 117, A4): see the contract's `AuditView`. */
  readonly askedAt?: number | undefined;
  readonly answers?: readonly ApprovalAnswer[] | undefined;
  readonly answeredAt?: number | null | undefined;
  readonly answer?: ApprovalAnswer | null | undefined;
  readonly exitCode?: number | undefined;
  readonly durationMs?: number | undefined;
}

export interface AuditPageQuery {
  /** The caller's rows and the system's (owner null); null asks for the system's alone. */
  readonly ownerId: string | null;
  readonly sessionId?: string | undefined;
  readonly before?: number | undefined;
  readonly limit: number;
}

export interface AuditStore {
  append(row: AuditInsert): void;
  page(query: AuditPageQuery): AuditRow[];
  /** Months (`YYYY-MM`) with rows that sort before `cutoff`, oldest first. */
  monthsBefore(cutoff: string): string[];
  count(month: string): number;
  /** One transaction: opens the prune (the trigger refuses a month not older than 12 months), deletes, closes, leaves its line. Returns the rows deleted. */
  prune(month: string, at: number): number;
}

interface RawRow {
  id: number;
  at: number;
  ownerId: string | null;
  actor: AuditRow["actor"];
  actorId: string | null;
  kind: AuditRow["kind"];
  sessionId: string | null;
  toolCallId: string | null;
  parentToolCallId: string | null;
  tool: string | null;
  category: string | null;
  decision: AuditRow["decision"];
  reason: string | null;
  stages: string | null;
  args: string | null;
  detail: string | null;
  askedAt: number | null;
  answers: string | null;
  answeredAt: number | null;
  answer: ApprovalAnswer | null;
  exitCode: number | null;
  durationMs: number | null;
}

const COLUMNS =
  "id, at, owner_id AS ownerId, actor, actor_id AS actorId, kind, session_id AS sessionId, tool_call_id AS toolCallId, " +
  "parent_tool_call_id AS parentToolCallId, tool, category, decision, reason, stages, args, detail, " +
  "asked_at AS askedAt, answers, answered_at AS answeredAt, answer, exit_code AS exitCode, duration_ms AS durationMs";

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

const Stages = z.array(StageVerdict).max(STAGE_IDS.length);
const Answers = z.array(ApprovalAnswer).max(5);

function toRow(raw: RawRow): AuditRow {
  // Valid JSON of the wrong shape (`[1]`) would fail the whole page at the contract: it reads as no stages.
  const stages = Stages.safeParse(parseJson(raw.stages));
  const detail = parseJson(raw.detail);
  const answers = raw.answers === null ? null : Answers.safeParse(parseJson(raw.answers));
  return {
    ...raw,
    answers: answers?.success ? answers.data : null,
    stages: stages.success ? stages.data : [],
    detail:
      typeof detail === "object" && detail !== null && !Array.isArray(detail)
        ? (detail as Record<string, unknown>)
        : null,
  };
}

export function createAuditStore(db: Db): AuditStore {
  function append(row: AuditInsert): void {
    db.run(
      "INSERT INTO audit (at, month, owner_id, actor, actor_id, kind, session_id, tool_call_id, parent_tool_call_id, " +
        "tool, category, decision, reason, stages, args, detail, asked_at, answers, answered_at, answer, exit_code, duration_ms) VALUES ($at, strftime('%Y-%m', $at / 1000, 'unixepoch'), " +
        "$ownerId, $actor, $actorId, $kind, $sessionId, $toolCallId, $parentToolCallId, $tool, $category, $decision, " +
        "$reason, $stages, $args, $detail, $askedAt, $answers, $answeredAt, $answer, $exitCode, $durationMs)",
      {
        at: row.at,
        ownerId: row.ownerId,
        actor: row.actor,
        actorId: row.actorId ?? null,
        kind: row.kind,
        sessionId: row.sessionId ?? null,
        toolCallId: row.toolCallId ?? null,
        parentToolCallId: row.parentToolCallId ?? null,
        tool: row.tool ?? null,
        category: row.category ?? null,
        decision: row.decision,
        reason: row.reason ?? null,
        stages: row.stages ? JSON.stringify(row.stages) : null,
        args: row.args ?? null,
        detail: row.detail ? JSON.stringify(row.detail) : null,
        askedAt: row.askedAt ?? null,
        answers: row.answers ? JSON.stringify(row.answers) : null,
        answeredAt: row.answeredAt ?? null,
        answer: row.answer ?? null,
        exitCode: row.exitCode ?? null,
        durationMs: row.durationMs ?? null,
      },
    );
  }
  return {
    append,
    page: ({ ownerId, sessionId, before, limit }) =>
      db
        .all<RawRow>(
          `SELECT ${COLUMNS} FROM audit WHERE (owner_id = $ownerId OR owner_id IS NULL) ` +
            "AND ($sessionId IS NULL OR session_id = $sessionId) AND ($before IS NULL OR id < $before) " +
            "ORDER BY id DESC LIMIT $limit",
          { ownerId, sessionId: sessionId ?? null, before: before ?? null, limit },
        )
        .map(toRow),
    monthsBefore: (cutoff) =>
      db
        .all<{ month: string }>("SELECT DISTINCT month FROM audit WHERE month < $cutoff ORDER BY month", {
          cutoff,
        })
        .map((r) => r.month),
    count: (month) =>
      db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit WHERE month = $month", { month })?.n ?? 0,
    prune: (month, at) =>
      db.transaction(() => {
        const opened = db.get<{ id: number }>(
          "INSERT INTO audit_prunes (month, state, at) VALUES ($month, 'open', $at) RETURNING id",
          { month, at },
        );
        const { changes } = db.run("DELETE FROM audit WHERE month = $month", { month });
        db.run("UPDATE audit_prunes SET state = 'done', rows = $rows WHERE id = $id", {
          id: opened?.id ?? 0,
          rows: changes,
        });
        append({
          at,
          ownerId: null,
          actor: "cli",
          kind: "audit",
          decision: "info",
          reason: "pruned",
          detail: { month, rows: changes },
        });
        return changes;
      }),
  };
}

/** The first month that is not prunable at `now` (UTC `YYYY-MM`): a month sorting before it is older than 12 months. */
export function monthCutoff(now: number): string {
  const at = new Date(now);
  return new Date(Date.UTC(at.getUTCFullYear() - 1, at.getUTCMonth(), 1)).toISOString().slice(0, 7);
}
