import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { AUDIT_MIGRATIONS } from "./index.ts";
import { createAuditStore } from "./store.ts";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the card timing migration (decision 117, A4)", () => {
  it("migrates a database from before it with no data change, and the old rows read null", () => {
    dir = mkdtempSync(join(tmpdir(), "pap-audit-card-"));
    const old = join(dir, "old");
    mkdirSync(old);
    copyFileSync(join(AUDIT_MIGRATIONS.dir, "202610122000_audit.sql"), join(old, "202610122000_audit.sql"));
    const options = {
      dbPath: join(dir, "s.db"),
      backupsDir: join(dir, "b"),
      clock: createFakeClock(Date.now()),
      logger: silentLogger,
    };
    const before = migrate({ ...options, sources: [KERNEL_MIGRATIONS, { module: "audit", dir: old }] }).db;
    before.run(
      "INSERT INTO audit (at, month, owner_id, actor, kind, decision, reason, args) VALUES (1000, '1970-01', 'u1', 'worker', 'call', 'approved', 'answer: once', 'ls')",
    );
    const snapshot = before.all(
      "SELECT id, at, month, owner_id, actor, kind, decision, reason, args FROM audit",
    );
    before.close();

    const after = migrate({ ...options, sources: [KERNEL_MIGRATIONS, AUDIT_MIGRATIONS] }).db;
    expect(
      after.all("SELECT id, at, month, owner_id, actor, kind, decision, reason, args FROM audit"),
    ).toEqual(snapshot);
    const store = createAuditStore(after);
    expect(store.page({ ownerId: "u1", limit: 5 })[0]).toMatchObject({
      reason: "answer: once",
      askedAt: null,
      answers: null,
      answeredAt: null,
      answer: null,
      exitCode: null,
      durationMs: null,
    });
    store.append({
      at: 2000,
      ownerId: "u1",
      actor: "user",
      kind: "call",
      decision: "approved",
      askedAt: 1500,
      answers: ["deny", "once"],
      answeredAt: 1900,
      answer: "once",
    });
    expect(store.page({ ownerId: "u1", limit: 1 })[0]).toMatchObject({
      askedAt: 1500,
      answers: ["deny", "once"],
      answeredAt: 1900,
      answer: "once",
    });
    after.close();
  });
});
