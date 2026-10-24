import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { M11_MIGRATION_SOURCES } from "./compose-m11.ts";
import { MIGRATION_SOURCES } from "./daemon.ts";
import { discoverMigrations } from "./kernel/db/migrate.ts";

describe("the daemon's M11 entry", () => {
  const source = readFileSync(fileURLToPath(new URL("./daemon.ts", import.meta.url)), "utf8");

  it("stops the platform dispatcher before the sessions' workers", () => {
    const stopsPlatform = source.indexOf("m11.stop()");
    const stopsSessions = source.indexOf("sessions.shutdownAll()");
    expect(stopsPlatform).toBeGreaterThan(0);
    expect(stopsSessions).toBeGreaterThan(stopsPlatform);
  });

  it("builds the M11 entry after the sessions module and lanes.bind", () => {
    const composed = source.indexOf("composeM11(");
    expect(composed).toBeGreaterThan(source.indexOf("lanes.bind("));
    expect(composed).toBeGreaterThan(source.indexOf("createSessionsModule("));
  });

  it("spreads its migration sources and its RPC table", () => {
    expect(source).toContain("...M11_MIGRATION_SOURCES");
    expect(source).toContain("...m11.rpc");
  });

  it("keeps the migrations in stamp order, M11's after every earlier one", () => {
    const ids = discoverMigrations(MIGRATION_SOURCES).map((migration) => migration.id);
    // The agent tasks' migration (1120), the runs' (1130) and the thread tasks' (1131) sort between the agents' (1110) and the Inbox's (1140).
    expect(ids.slice(-14, -6)).toEqual([
      "automation/202610151120_agent_tasks.sql",
      "runs/202610151130_run_agents.sql",
      "automation/202610151131_thread_tasks.sql",
      "inbox/202610151140_agent_items.sql",
      "lanes/202610151150_lane_note.sql",
      "sessions/202610151152_owner_preset.sql",
      "automation/202610151153_task_setter.sql",
      "subagents/202610151155_subagents.sql",
    ]);
    // The trash entry's table (J1b): an agents migration, stamped after the approvals fix's audit one; then the refused-host card's kind.
    expect(ids.slice(-6)).toEqual([
      "push/202610172000_push.sql",
      "audit/202610191000_audit_card_timing.sql",
      "agents/202610201300_agent_trash.sql",
      "agents/202610211200_agent_events_egress.sql",
      "inbox/202610231200_drop_memory_review.sql",
      "projects/202610231300_project_boxes.sql",
    ]);
    expect(discoverMigrations(M11_MIGRATION_SOURCES).map((migration) => migration.id)).toEqual([
      "agents/202610151110_agents.sql",
      "subagents/202610151155_subagents.sql",
      "agents/202610201300_agent_trash.sql",
      "agents/202610211200_agent_events_egress.sql",
    ]);
  });
});
