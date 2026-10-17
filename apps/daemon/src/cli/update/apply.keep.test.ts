import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { harness, URL_READY, type Harness } from "../testing/apply-harness.ts";
import { applyRelease } from "./apply.ts";
import { readCurrent } from "./releases.ts";

let h: Harness | undefined;
afterEach(() => {
  if (h) chmodSync(join(h.home, "backups"), 0o700);
  h?.cleanup();
});

const NEVER = { kind: "never" } as const;
const kept = (home: string): string[] =>
  readdirSync(join(home, "backups")).filter((n) => n.startsWith("pre-rollback-"));

describe("a rollback that replaces the database keeps the database it replaced", () => {
  it("backups/pre-rollback-<stamp>.db holds the migrated database, rows and ids included", async () => {
    h = harness({ ctl: { migrate: true, listening: [NEVER, URL_READY] } });
    const outcome = await applyRelease(h.deps, "new");
    expect(outcome).toMatchObject({ kind: "rolled_back", restoredDatabase: true });
    expect(h.rows()).toEqual(["a"]);
    const files = kept(h.home);
    expect(files).toHaveLength(1);
    // the outcome names the file the rollback just kept, as an absolute path that exists (what the messages print)
    expect(outcome).toMatchObject({ keptDatabase: join(h.home, "backups", files[0] ?? "") });
    expect(existsSync(join(h.home, "backups", files[0] ?? ""))).toBe(true);
    const copy = new DatabaseSync(join(h.home, "backups", files[0] ?? ""), { readOnly: true });
    try {
      expect(
        (copy.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: string }[]).map(
          (r) => r.id,
        ),
      ).toEqual(["001", "002"]);
      expect(
        (copy.prepare("SELECT body FROM note ORDER BY rowid").all() as { body: string }[]).map((r) => r.body),
      ).toEqual(["a", "m"]);
    } finally {
      copy.close();
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    "when the copy cannot be kept the rollback ends rollback_failed / database and the database is untouched",
    async () => {
      let home = "";
      // the update's own snapshot is already in backups/; the second stop is the rollback's
      h = harness({
        ctl: {
          migrate: true,
          listening: [NEVER, URL_READY],
          stopHook: (n) => {
            if (n === 1) chmodSync(join(home, "backups"), 0o500);
          },
        },
      });
      home = h.home;
      const outcome = await applyRelease(h.deps, "new");
      expect(outcome).toMatchObject({ kind: "rollback_failed", step: "database" });
      expect(h.ids()).toEqual(["001", "002"]);
      expect(readCurrent(h.app)).toBe("new");
    },
  );
});
