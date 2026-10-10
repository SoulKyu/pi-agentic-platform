import type { Clock } from "../clock.ts";
import type { Db } from "./database.ts";

export function ensureInstallTimestamp(db: Db, clock: Clock): number {
  const row = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'installed_at'");
  if (row) return Number(row.value);
  const now = clock.now();
  if (!db.readOnly)
    db.run("INSERT INTO meta (key, value) VALUES ('installed_at', $value)", { value: String(now) });
  return now;
}
