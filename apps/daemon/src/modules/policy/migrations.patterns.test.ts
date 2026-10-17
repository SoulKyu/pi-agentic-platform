import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { kernelBeforeOutbox } from "../../kernel/testing/old-kernel.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { SESSIONS_MIGRATIONS } from "../sessions/index.ts";
import { POLICY_MIGRATIONS } from "./index.ts";
import { createPolicyStore } from "./store.ts";

const STAMP = "202610131000_pattern_rules.sql";
const KEY = "a".repeat(64);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-policy-patterns-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const open = (sources: Parameters<typeof migrate>[0]["sources"]) =>
  migrate({
    dbPath: join(dir, "s.db"),
    backupsDir: join(dir, "b"),
    sources,
    clock: createFakeClock(),
    logger: silentLogger,
  }).db;

/** The sessions migrations without the one that sorts after the policy ones: the home as it was before them. */
function sessionsBefore() {
  const old = join(dir, "sessions-before");
  mkdirSync(old);
  for (const file of readdirSync(SESSIONS_MIGRATIONS.dir).filter(
    (name) =>
      name !== "202610131020_pap_wrote_at.sql" &&
      name !== "202610131030_tool_preset.sql" &&
      name !== "202610151100_session_kinds.sql" &&
      name !== "202610151152_owner_preset.sql",
  ))
    copyFileSync(join(SESSIONS_MIGRATIONS.dir, file), join(old, file));
  return { module: SESSIONS_MIGRATIONS.module, dir: old };
}

/** The policy migrations the home had before this one: every file but the pattern one. */
function homeBeforePatterns() {
  const old = join(dir, "policy-before-patterns");
  mkdirSync(old);
  for (const file of readdirSync(POLICY_MIGRATIONS.dir).filter(
    (name) => name !== STAMP && name !== "202610142040_tool_allowlist.sql",
  ))
    copyFileSync(join(POLICY_MIGRATIONS.dir, file), join(old, file));
  return open([kernelBeforeOutbox(dir), sessionsBefore(), { module: POLICY_MIGRATIONS.module, dir: old }]);
}
const full = () => open([KERNEL_MIGRATIONS, SESSIONS_MIGRATIONS, POLICY_MIGRATIONS]);
const insert = (db: ReturnType<typeof full>, id: string, extra = "", values = "") =>
  db.run(
    `INSERT INTO approval_rules (id, owner_id, scope_kind, scope, tool, grant_key, label, created_at${extra}) VALUES ('${id}', 'u1', 'project', '/w', 'bash', '${id.padEnd(64, "0")}', 'l', 1${values})`,
  );

describe("the pattern rules migration (M7 Task 2b)", () => {
  it("is the file the plan names", () => {
    expect(readdirSync(POLICY_MIGRATIONS.dir)).toContain(STAMP);
  });

  it("applies on a home with M5 rules, which read back as exact rules with no pattern", () => {
    const before = homeBeforePatterns();
    before.run(
      "INSERT INTO approval_rules (id, owner_id, scope_kind, scope, tool, grant_key, label, created_at) VALUES ('old', 'u1', 'project', '/w', 'bash', $key, 'bash: ls', 5)",
      { key: KEY },
    );
    before.close();
    const db = full();
    expect(createPolicyStore(db).get("u1", "old")).toMatchObject({
      id: "old",
      kind: "exact",
      pattern: null,
      grantKey: KEY,
      label: "bash: ls",
    });
    db.close();
  });

  it("refuses a kind outside exact, prefix and tool", () => {
    const db = full();
    expect(() => insert(db, "g", ", kind", ", 'glob'")).toThrow(/CHECK/);
    for (const kind of ["exact", "prefix", "tool"])
      expect(() => insert(db, kind, ", kind", `, '${kind}'`)).not.toThrow();
    db.close();
  });

  it("refuses a pattern that is not JSON or longer than 1024 characters, and takes a null or valid one", () => {
    const db = full();
    expect(() => insert(db, "a", ", pattern", ", 'not json'")).toThrow(/CHECK/);
    const long = JSON.stringify(["x".repeat(1100)]);
    expect(() => insert(db, "b", ", pattern", `, '${long}'`)).toThrow(/CHECK/);
    const edge = JSON.stringify(["x".repeat(1024 - 4)]);
    expect(edge).toHaveLength(1024);
    expect(() => insert(db, "c", ", pattern", `, '${edge}'`)).not.toThrow();
    expect(() => insert(db, "d", ", pattern", `, '["pnpm","test"]'`)).not.toThrow();
    expect(() => insert(db, "e", ", pattern", `, '{"source":"mcp"}'`)).not.toThrow();
    expect(() => insert(db, "f")).not.toThrow();
    db.close();
  });
});
