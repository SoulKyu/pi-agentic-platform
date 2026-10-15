import { afterEach, describe, expect, it } from "vitest";
import type { SqlParams } from "../../kernel/db/database.ts";
import { createAutomationBed, type AutomationBed } from "./testing/bed.ts";

let bed: AutomationBed;
afterEach(() => bed.dispose());

function insertTrigger(id = "t1", overrides: SqlParams = {}): void {
  bed.db.run(
    `INSERT INTO triggers (id, owner_id, name, enabled, source_type, config, cwd, created_at, updated_at)
     VALUES ($id, 'u1', $name, 1, $sourceType, $config, '/x', 1, 1)`,
    { id, name: "n", sourceType: "manual", config: "{}", ...overrides },
  );
}

function insertTask(id: string, state: string, overrides: SqlParams = {}): void {
  const finished = ["done", "failed", "cancelled", "interrupted"].includes(state);
  bed.db.run(
    `INSERT INTO tasks (id, owner_id, trigger_id, origin, state, cwd, prompt, tainted, policy, title, max_run_ms,
       created_at, ended_at)
     VALUES ($id, 'u1', $triggerId, 'manual', $state, '/x', 'p', 0, '{}', 'title', $maxRunMs, 1, $endedAt)`,
    { id, triggerId: "t1", state, endedAt: finished ? 2 : null, maxRunMs: 60_000, ...overrides },
  );
}

const refused =
  (sql: string, params: SqlParams = {}) =>
  () =>
    bed.db.run(sql, params);

describe("automation tables", () => {
  it("a finished task cannot change state, reason, ended_at, title, session_id or gated", () => {
    bed = createAutomationBed();
    insertTrigger();
    insertTask("k1", "done");
    for (const column of [
      "state = 'failed'",
      "reason = 'x'",
      "ended_at = 3",
      "title = 'other'",
      "session_id = 's'",
      "gated = 0",
    ])
      expect(refused(`UPDATE tasks SET ${column} WHERE id = 'k1'`), column).toThrow(
        /a finished task does not change/,
      );
    expect(refused("UPDATE tasks SET prompt = 'other' WHERE id = 'k1'")).toThrow(
      /a finished task does not change/,
    );
  });

  it("gated defaults to 1, and the queued to running commit changes one row once", () => {
    bed = createAutomationBed();
    insertTrigger();
    insertTask("k1", "queued");
    expect(bed.db.get<{ gated: number }>("SELECT gated FROM tasks WHERE id = 'k1'")?.gated).toBe(1);
    const commit = "UPDATE tasks SET state = 'running', started_at = 5 WHERE id = 'k1' AND state = 'queued'";
    expect(bed.db.run(commit).changes).toBe(1);
    expect(bed.db.run(commit).changes).toBe(0);
  });

  it("deleting a trigger keeps its tasks with a NULL trigger and removes its journal and seen-feed rows", () => {
    bed = createAutomationBed();
    insertTrigger();
    insertTask("k1", "done");
    insertTask("k2", "running", { endedAt: null });
    bed.db.run(
      "INSERT INTO trigger_fires (trigger_id, owner_id, source, verdict, first_at, last_at) VALUES ('t1', 'u1', 'manual', 'fired', 1, 1)",
    );
    bed.db.run("INSERT INTO feed_seen (trigger_id, entry, seen_at) VALUES ('t1', $entry, 1)", {
      entry: "a".repeat(64),
    });
    bed.db.run("DELETE FROM triggers WHERE id = 't1'");
    expect(
      bed.db.all<{ id: string; trigger_id: string | null }>("SELECT id, trigger_id FROM tasks ORDER BY id"),
    ).toEqual([
      { id: "k1", trigger_id: null },
      { id: "k2", trigger_id: null },
    ]);
    expect(bed.db.get<{ n: number }>("SELECT count(*) AS n FROM trigger_fires")?.n).toBe(0);
    expect(bed.db.get<{ n: number }>("SELECT count(*) AS n FROM feed_seen")?.n).toBe(0);
  });

  it("a finished task cannot be pointed at another trigger", () => {
    bed = createAutomationBed();
    insertTrigger("t1");
    insertTrigger("t2");
    insertTask("k1", "done");
    expect(refused("UPDATE tasks SET trigger_id = 't2' WHERE id = 'k1'")).toThrow(
      /a finished task does not change/,
    );
  });

  it("refuses max_run_ms below 60 000 and accepts 60 000", () => {
    bed = createAutomationBed();
    insertTrigger();
    expect(() => insertTask("k1", "queued", { maxRunMs: 59_999 })).toThrow(/CHECK/);
    expect(() => insertTask("k2", "queued", { maxRunMs: 60_000 })).not.toThrow();
  });

  it("refuses a bad journal verdict and a last_at before first_at", () => {
    bed = createAutomationBed();
    insertTrigger();
    const insert = (verdict: string, first: number, last: number) =>
      bed.db.run(
        "INSERT INTO trigger_fires (trigger_id, owner_id, source, verdict, first_at, last_at) VALUES ('t1', 'u1', 'manual', $verdict, $first, $last)",
        { verdict, first, last },
      );
    expect(() => insert("exploded", 1, 1)).toThrow(/CHECK/);
    expect(() => insert("fired", 5, 4)).toThrow(/CHECK/);
    expect(() => insert("fired", 5, 5)).not.toThrow();
  });

  it("refuses a config that is not JSON, an empty name and an unknown source type", () => {
    bed = createAutomationBed();
    expect(() => insertTrigger("t1", { config: "{nope" })).toThrow(/CHECK/);
    expect(() => insertTrigger("t2", { name: "" })).toThrow(/CHECK/);
    expect(() => insertTrigger("t3", { sourceType: "carrier-pigeon" })).toThrow(/CHECK/);
    expect(() => insertTrigger("t4", { config: `{"p":"${"x".repeat(65_536)}"}` })).toThrow(/CHECK/);
    expect(() => insertTrigger("t5")).not.toThrow();
  });
});
