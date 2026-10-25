import type { Db } from "../../kernel/db/database.ts";

/**
 * The tables a deleted member's rows stay in (OQ2, decision 129): the runs are the cost of the owner's API keys and the audit
 * is the trail if a member is deleted for misuse. Neither holds content.
 */
export const KEPT_TABLES: ReadonlySet<string> = new Set(["runs", "audit"]);

const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * Deletes every row that names the user in a column `owner_id` or `user_id`, in every table of the database, except the
 * kept ones. Found through `sqlite_master`, so a table a later milestone adds is covered with no list to keep. Returns the
 * tables touched and the rows removed from each.
 */
export function deleteOwnerRows(db: Db, userId: string): Array<{ table: string; rows: number }> {
  const tables = db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .map((row) => row.name)
    .filter((name) => !KEPT_TABLES.has(name));
  return db.transaction(() => {
    const touched: Array<{ table: string; rows: number }> = [];
    for (const table of tables) {
      const columns = db
        .all<{ name: string }>("SELECT name FROM pragma_table_info($table)", { table })
        .map((row) => row.name)
        .filter((name) => name === "owner_id" || name === "user_id");
      if (columns.length === 0) continue;
      const where = columns.map((column) => `${quoted(column)} = $userId`).join(" OR ");
      const rows = db.run(`DELETE FROM ${quoted(table)} WHERE ${where}`, { userId }).changes;
      touched.push({ table, rows });
    }
    return touched;
  });
}
