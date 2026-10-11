import type { Db } from "../../kernel/db/database.ts";

export interface RuleRow {
  readonly id: string;
  readonly ownerId: string;
  readonly scope: string;
  readonly tool: string;
  readonly grantKey: string;
  readonly label: string;
  readonly createdAt: number;
}
const COLUMNS = "id, owner_id AS ownerId, scope, tool, grant_key AS grantKey, label, created_at AS createdAt";

export function createPolicyStore(db: Db) {
  return {
    /** False when the same owner already has this exact rule in this project. */
    insert: (row: RuleRow): boolean =>
      db.run(
        "INSERT INTO approval_rules (id, owner_id, scope_kind, scope, tool, grant_key, label, created_at) VALUES ($id, $ownerId, 'project', $scope, $tool, $grantKey, $label, $createdAt) ON CONFLICT DO NOTHING RETURNING id",
        { ...row },
      ).changes > 0,
    count: (ownerId: string, scope: string): number =>
      db.get<{ n: number }>(
        "SELECT count(*) AS n FROM approval_rules WHERE owner_id = $ownerId AND scope_kind = 'project' AND scope = $scope",
        { ownerId, scope },
      )?.n ?? 0,
    forScope: (ownerId: string, scope: string, limit: number): RuleRow[] =>
      db.all<RuleRow>(
        `SELECT ${COLUMNS} FROM approval_rules WHERE owner_id = $ownerId AND scope_kind = 'project' AND scope = $scope ORDER BY created_at, id LIMIT $limit`,
        { ownerId, scope, limit },
      ),
    forOwner: (ownerId: string, limit: number): RuleRow[] =>
      db.all<RuleRow>(
        `SELECT ${COLUMNS} FROM approval_rules WHERE owner_id = $ownerId ORDER BY created_at DESC, id LIMIT $limit`,
        { ownerId, limit },
      ),
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
