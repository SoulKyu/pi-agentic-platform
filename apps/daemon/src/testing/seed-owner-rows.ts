import type { Db, SqlParams, SqlValue } from "../kernel/db/database.ts";

interface Column {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
}

/** Values a CHECK constraint needs; every other column gets a unique filler from its type. */
const FIXED: Record<string, Record<string, SqlValue>> = {
  push_subs: { locale: "en" },
  push_events: { state: "pending" },
  audit: { at: 1_700_000_000_000, month: "2023-11" },
  api_tokens: { hint: "abcd" },
};

/** What the table's own definition lets a column hold: the first word of its `IN (...)` list, `{}` for a JSON column. */
function allowed(sql: string, name: string): SqlValue | undefined {
  const list = new RegExp(`\\b${name}\\s+IN\\s*\\(\\s*'([^']+)'`).exec(sql)?.[1];
  if (list !== undefined) return list;
  if (new RegExp(`json_valid\\(${name}\\)`).test(sql)) return "{}";
  const length = new RegExp(`length\\(${name}\\) (?:=|IN \\() ?(\\d+)`).exec(sql)?.[1];
  if (length !== undefined) return "x".repeat(Number(length));
  const between = new RegExp(`\\b${name} BETWEEN (\\d+) AND`).exec(sql)?.[1];
  return between === undefined ? undefined : Number(between);
}

let lastName = "";

const filler = (table: string, column: Column, counter: number, sql: string): SqlValue => {
  if (table === "agents" && column.name === "name") return (lastName = `a${counter}`);
  if (table === "agents" && column.name === "name_key") return lastName;
  if (new RegExp(`substr\\(${column.name}, 1, 1\\) = '/'`).test(sql)) return `/x/${counter}`;
  const fixed = FIXED[table]?.[column.name] ?? allowed(sql, column.name);
  if (fixed !== undefined) return fixed;
  const type = column.type.toUpperCase();
  if (type.includes("INT")) return 1;
  if (type.includes("REAL")) return 1;
  if (type.includes("BLOB")) return new Uint8Array([1]);
  return `${table}-${column.name}-${counter}`;
};

let counter = 0;

/**
 * Gives each of the owners one row in every table that has an `owner_id` or `user_id` column (found through `sqlite_master`,
 * as the delete finds them), plus the push deliveries that name their subscriptions. Foreign keys are off while it writes.
 * Returns, per owner, the tables that got a row; a table whose constraints a generic row cannot meet is left out and is
 * listed by the test that depends on it. `only` limits it to those tables (a live daemon is not given rows it would act on).
 */
export function seedOwnerRows(
  db: Db,
  owners: readonly string[],
  only?: readonly string[],
): Map<string, string[]> {
  db.exec("PRAGMA foreign_keys = OFF");
  const seeded = new Map<string, string[]>();
  try {
    const definitions = new Map(
      db
        .all<{ name: string; sql: string }>(
          "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .map((row) => [row.name, row.sql]),
    );
    const tables = only ?? [...definitions.keys()];
    for (const owner of owners) {
      const done: string[] = [];
      for (const table of tables) {
        const columns = db.all<Column>(
          'SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info($table)',
          {
            table,
          },
        );
        const ownerColumns = columns.filter(
          (column) => column.name === "owner_id" || column.name === "user_id",
        );
        if (ownerColumns.length === 0) continue;
        const values: SqlParams = {};
        for (const column of columns) {
          const isOwner = ownerColumns.includes(column);
          const isRowid = column.pk === 1 && column.type.toUpperCase() === "INTEGER";
          if (isRowid) continue;
          if (isOwner) values[column.name] = owner;
          else if (column.notnull === 1 && column.dflt_value === null)
            values[column.name] = filler(table, column, counter++, definitions.get(table) ?? "");
          else if (FIXED[table]?.[column.name] !== undefined)
            values[column.name] = FIXED[table][column.name] as SqlValue;
        }
        const names = Object.keys(values);
        try {
          db.run(
            `INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(", ")}) VALUES (${names.map((name) => `$${name}`).join(", ")})`,
            values,
          );
          done.push(table);
        } catch {
          // A constraint a generic row cannot meet: the table is not seeded, and the caller sees it missing.
        }
      }
      for (const sub of db.all<{ id: string }>("SELECT id FROM push_subs WHERE owner_id = $owner", {
        owner,
      })) {
        for (const event of db.all<{ id: string }>("SELECT id FROM push_events WHERE owner_id = $owner", {
          owner,
        }))
          db.run(
            "INSERT INTO push_deliveries (event_id, sub_id, state, next_at) VALUES ($event, $sub, 'pending', 1)",
            { event: event.id, sub: sub.id },
          );
        done.push("push_deliveries");
      }
      seeded.set(owner, done);
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  return seeded;
}
