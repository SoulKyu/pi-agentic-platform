import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";

const db = new sqlite.DatabaseSync(":memory:");
const result = {
  node: process.version,
  sqliteVersion: (db.prepare("select sqlite_version() as v").get() as { v: string }).v,
  compileFts5: (db.prepare("pragma compile_options").all() as Array<{ compile_options: string }>).some((row) => row.compile_options === "ENABLE_FTS5"),
  fts5: false,
  bm25: false,
  snippet: false,
  diacriticsFolded: false,
  strictTables: false,
  returning: false,
  wal: false,
  backupApi: typeof (sqlite as Record<string, unknown>).backup === "function",
  index10kMs: 0,
  query10kMs: 0,
  error: null as string | null,
};

try {
  db.exec("create virtual table docs using fts5(title, body, tokenize = 'unicode61 remove_diacritics 2')");
  result.fts5 = true;
  const insert = db.prepare("insert into docs(title, body) values (?, ?)");
  const t0 = performance.now();
  db.exec("begin");
  for (let i = 0; i < 10_000; i++) insert.run(`session ${i}`, `fix the websocket reconnect bug ${i} café ${i % 7 === 0 ? "kubernetes" : "terraform"}`);
  db.exec("commit");
  result.index10kMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  const rows = db
    .prepare("select bm25(docs) as score, snippet(docs, 1, '[', ']', '…', 8) as snip from docs where docs match ? order by score limit 10")
    .all("kubernetes cafe") as Array<{ score: number; snip: string }>;
  result.query10kMs = Math.round(performance.now() - t1);
  result.bm25 = rows.length > 0 && typeof rows[0]?.score === "number";
  result.snippet = rows.some((row) => row.snip.includes("["));
  result.diacriticsFolded = rows.length > 0;
  db.exec("create table t (id integer primary key, v text not null) strict");
  result.strictTables = true;
  result.returning = (db.prepare("insert into t(v) values ('x') returning id").get() as { id: number }).id === 1;
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
}

const dir = mkdtempSync(join(tmpdir(), "pap-s3-"));
const fileDb = new sqlite.DatabaseSync(join(dir, "wal.db"));
result.wal = (fileDb.prepare("pragma journal_mode = wal").get() as { journal_mode: string }).journal_mode === "wal";
fileDb.close();
rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify(result, null, 2));
