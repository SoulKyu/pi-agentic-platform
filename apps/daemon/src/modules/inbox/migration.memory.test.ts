import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { INBOX_MIGRATIONS } from "./index.ts";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the memory_review row migration (decision 123)", () => {
  it("deletes the memory_review rows and keeps every other kind", () => {
    dir = mkdtempSync(join(tmpdir(), "pap-inbox-mig-"));
    const old = join(dir, "old");
    mkdirSync(old);
    for (const file of ["202610142030_inbox.sql", "202610151140_agent_items.sql"]) {
      copyFileSync(join(INBOX_MIGRATIONS.dir, file), join(old, file));
    }
    const options = {
      dbPath: join(dir, "s.db"),
      backupsDir: join(dir, "b"),
      clock: createFakeClock(Date.now()),
      logger: silentLogger,
    };
    const before = migrate({ ...options, sources: [KERNEL_MIGRATIONS, { module: "inbox", dir: old }] }).db;
    for (const [id, kind, ref] of [
      ["i1", "memory_review", "r1"],
      ["i2", "approval", "r2"],
    ] as const) {
      before.run(
        "INSERT INTO inbox_items (id, owner_id, kind, to_handle, title, created_at, ref_id) VALUES ($id, 'u1', $kind, 1, 't', 1, $ref)",
        { id, kind, ref },
      );
    }
    before.close();
    const after = migrate({ ...options, sources: [KERNEL_MIGRATIONS, INBOX_MIGRATIONS] }).db;
    expect(after.all("SELECT id, kind FROM inbox_items")).toEqual([{ id: "i2", kind: "approval" }]);
    after.close();
  });
});
