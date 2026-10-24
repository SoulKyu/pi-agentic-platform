import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATION_SOURCES } from "./daemon.ts";
import { createFakeClock } from "./kernel/clock.ts";
import { migrate } from "./kernel/db/migrate.ts";
import { silentLogger } from "./kernel/logger.ts";
import { sourcesBeforeM10 } from "./kernel/testing/old-kernel.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-m10-over-m9-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const options = () => ({
  dbPath: join(dir, "state.db"),
  backupsDir: join(dir, "backups"),
  clock: createFakeClock(),
  logger: silentLogger,
});

describe("M10's migrations over a home M9 left (the preview's state.db)", () => {
  it("applies M10's and M11's migrations only, in order, and keeps what M9 wrote", () => {
    const m9 = migrate({ ...options(), sources: sourcesBeforeM10(dir, MIGRATION_SOURCES) });
    expect(m9.applied).toContain("worktrees/202610141000_worktrees.sql");
    expect(m9.applied).toContain("lanes/202610141010_lanes.sql");
    expect(m9.applied.some((id) => id.includes("outbox") || id.includes("automation"))).toBe(false);
    m9.db.run(
      `INSERT INTO worktrees (path, owner_id, repo_root, branch, base_oid, created_branch, state, created_at, updated_at)
       VALUES ('/pap/wt/a', 'u1', '/repo', 'pap/a', '${"a".repeat(40)}', 1, 'ready', 1, 1)`,
    );
    m9.db.close();

    const m10 = migrate({ ...options(), sources: MIGRATION_SOURCES });
    expect(m10.readOnly).toBe(false);
    expect(m10.applied).toEqual([
      "kernel/202610142000_outbox.sql",
      "runs/202610142010_runs.sql",
      "automation/202610142020_automation.sql",
      "inbox/202610142030_inbox.sql",
      "policy/202610142040_tool_allowlist.sql",
      "sessions/202610151100_session_kinds.sql",
      "agents/202610151110_agents.sql",
      "automation/202610151120_agent_tasks.sql",
      "runs/202610151130_run_agents.sql",
      "automation/202610151131_thread_tasks.sql",
      "inbox/202610151140_agent_items.sql",
      "lanes/202610151150_lane_note.sql",
      "sessions/202610151152_owner_preset.sql",
      "automation/202610151153_task_setter.sql",
      "subagents/202610151155_subagents.sql",
      "push/202610172000_push.sql",
      "audit/202610191000_audit_card_timing.sql",
      "agents/202610201300_agent_trash.sql",
      "agents/202610211200_agent_events_egress.sql",
      "inbox/202610231200_drop_memory_review.sql",
      "projects/202610231300_project_boxes.sql",
      "projects/202610241200_project_github.sql",
    ]);
    expect(m10.db.all("SELECT path, state FROM worktrees")).toEqual([{ path: "/pap/wt/a", state: "ready" }]);
    const tables = m10.db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining(["outbox", "runs", "triggers", "tasks", "inbox_items", "agents"]),
    );
    m10.db.close();
  });

  it("is a no-op the third time: nothing pending, nothing refused", () => {
    migrate({ ...options(), sources: sourcesBeforeM10(dir, MIGRATION_SOURCES) }).db.close();
    migrate({ ...options(), sources: MIGRATION_SOURCES }).db.close();
    const again = migrate({ ...options(), sources: MIGRATION_SOURCES });
    expect(again.applied).toEqual([]);
    again.db.close();
  });
});
