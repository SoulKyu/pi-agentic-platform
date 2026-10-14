import type { Db } from "../../kernel/db/database.ts";
import type { RuleKind } from "./pattern-rules.ts";

export interface RuleRow {
  readonly id: string;
  readonly ownerId: string;
  readonly scope: string;
  readonly tool: string;
  readonly grantKey: string;
  readonly label: string;
  readonly createdAt: number;
  readonly kind: RuleKind;
  /** A JSON array of words (prefix) or {"source":…} (tool); null for an exact rule. */
  readonly pattern: string | null;
}
const COLUMNS =
  "id, owner_id AS ownerId, scope, tool, grant_key AS grantKey, label, created_at AS createdAt, kind, pattern";

export function createPolicyStore(db: Db) {
  return {
    /** False when the same owner already has this exact rule in this project. */
    insert: (row: RuleRow): boolean =>
      db.run(
        "INSERT INTO approval_rules (id, owner_id, scope_kind, scope, tool, grant_key, label, created_at, kind, pattern) VALUES ($id, $ownerId, 'project', $scope, $tool, $grantKey, $label, $createdAt, $kind, $pattern) ON CONFLICT DO NOTHING RETURNING id",
        { ...row },
      ).changes > 0,
    count: (ownerId: string, scope: string): number =>
      db.get<{ n: number }>(
        "SELECT count(*) AS n FROM approval_rules WHERE owner_id = $ownerId AND scope_kind = 'project' AND scope = $scope",
        { ownerId, scope },
      )?.n ?? 0,
    /** One project's rules of one kind, oldest first. */
    forScope: (ownerId: string, scope: string, kind: RuleKind, limit: number): RuleRow[] =>
      db.all<RuleRow>(
        `SELECT ${COLUMNS} FROM approval_rules WHERE owner_id = $ownerId AND scope_kind = 'project' AND scope = $scope AND kind = $kind ORDER BY created_at, id LIMIT $limit`,
        { ownerId, scope, kind, limit },
      ),
    /** Newest first, ties broken by id: one project's rules, or (scope null) all of the owner's. */
    newest: (ownerId: string, scope: string | null, limit: number): RuleRow[] =>
      db.all<RuleRow>(
        `SELECT ${COLUMNS} FROM approval_rules WHERE owner_id = $ownerId AND ($scope IS NULL OR (scope_kind = 'project' AND scope = $scope)) ORDER BY created_at DESC, id DESC LIMIT $limit`,
        { ownerId, scope, limit },
      ),
    /** Runs `fn` in one write transaction (BEGIN IMMEDIATE), nested calls join it. */
    transaction: <T>(fn: () => T): T => db.transaction(fn),
    get: (ownerId: string, id: string): RuleRow | undefined =>
      db.get<RuleRow>(`SELECT ${COLUMNS} FROM approval_rules WHERE owner_id = $ownerId AND id = $id`, {
        ownerId,
        id,
      }),
    exists: (ownerId: string, scope: string, tool: string, grantKey: string): boolean =>
      db.get<{ n: number }>(
        "SELECT count(*) AS n FROM approval_rules WHERE owner_id = $ownerId AND scope_kind = 'project' AND scope = $scope AND tool = $tool AND grant_key = $grantKey",
        { ownerId, scope, tool, grantKey },
      )?.n === 1,
    remove: (ownerId: string, id: string): boolean =>
      db.run("DELETE FROM approval_rules WHERE owner_id = $ownerId AND id = $id", { ownerId, id }).changes >
      0,
  };
}
export type PolicyStore = ReturnType<typeof createPolicyStore>;
