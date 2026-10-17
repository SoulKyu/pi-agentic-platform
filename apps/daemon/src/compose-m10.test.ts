import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AutomationSettings } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeM10, composeM10Early, M10_MIGRATION_SOURCES } from "./compose-m10.ts";
import { AUTOMATION_MIGRATIONS } from "./modules/automation/index.ts";
import { INBOX_MIGRATIONS } from "./modules/inbox/index.ts";
import { RUNS_MIGRATIONS } from "./modules/runs/index.ts";
import { claimEffect, enqueueEffect } from "./kernel/outbox/store.ts";
import type { PolicyPort } from "./modules/policy/index.ts";
import type { ProjectsPort } from "./modules/projects/index.ts";
import type { SessionsModule } from "./modules/sessions/index.ts";
import type { SettingsModule } from "./modules/settings/index.ts";
import { openM10Core, type M10TestCore } from "./testing/m10-core.ts";

let open: M10TestCore | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
});

const seedLeased = (test: M10TestCore): number => {
  const { db, clock } = test.bed;
  const id = enqueueEffect(
    db,
    { kind: "task.start", ownerId: "u1", payload: { taskId: "t1" } },
    clock.now(),
  ) as number;
  claimEffect(db, id, "task.start", clock.now());
  return id;
};
const modules = {
  audit: { port: { append: () => {}, reserve: () => true, fromWorker: () => null } },
  projects: { port: { ensure: () => null } as unknown as ProjectsPort },
  policy: {
    port: {
      scopeOf: (cwd: string) => cwd,
      endTaskPolicy: () => {},
      sessionPolicy: () => ({ toolAllowlist: null, recorded: false }),
      unattendedSessions: () => [],
    } as unknown as PolicyPort,
  },
  sessions: {
    modeOf: () => "supervised",
    sandboxedThread: () => false,
    kindOf: () => null,
    automation: {
      onAttention: () => () => {},
      workers: () => ({ used: 0, max: 4 }),
    } as unknown as SessionsModule["automation"],
  },
  settings: { port: { automation: () => AutomationSettings.parse({}) } } as unknown as SettingsModule,
} satisfies Parameters<typeof composeM10>[2];

describe("composeM10", () => {
  it("has the automation, runs and inbox migration sources", () => {
    expect(M10_MIGRATION_SOURCES).toEqual([AUTOMATION_MIGRATIONS, RUNS_MIGRATIONS, INBOX_MIGRATIONS]);
  });

  it("serves the seven trigger methods, the task methods, fire, dry-run, the journal and the usage summary", () => {
    open = openM10Core();
    const late = composeM10(open.core, composeM10Early(open.core), modules);
    expect(Object.keys(late.rpc).sort()).toEqual([
      "automation.dryRun",
      "automation.failures.dismiss",
      "automation.fire",
      "automation.journal",
      "automation.tasks.cancel",
      "automation.tasks.releaseTools",
      "automation.tasks.retry",
      "automation.triggers.create",
      "automation.triggers.delete",
      "automation.triggers.get",
      "automation.triggers.list",
      "automation.triggers.rotateSecret",
      "automation.triggers.setEnabled",
      "automation.triggers.update",
      "inbox.list",
      "inbox.markRead",
      "subscribe.inbox",
      "subscribe.tasks",
      "subscribe.usage",
      "usage.cancelResume",
      "usage.resumeNow",
      "usage.summary",
    ]);
  });

  it("composeM10Early recovers the outbox before it returns", () => {
    open = openM10Core();
    const id = seedLeased(open);
    composeM10Early(open.core);
    expect(
      open.bed.db.get<{ status: string }>("SELECT status FROM outbox WHERE id = $id", { id })?.status,
    ).toBe("retired");
  });

  it("start arms the outbox and stop stops it, leaving no timer", async () => {
    open = openM10Core();
    const early = composeM10Early(open.core);
    const late = composeM10(open.core, early, modules);
    const { db } = open.bed;
    // composeM10 registers every outbox kind for real: the row is settled by attachment.cleanup's own handler.
    const settled = (id: number) =>
      db.get<{ settled_at: number | null }>("SELECT settled_at FROM outbox WHERE id = $id", { id })
        ?.settled_at ?? null;
    const first = enqueueEffect(
      db,
      { kind: "attachment.cleanup", ownerId: "u1", payload: { day: "2026-10-02" } },
      open.bed.clock.now(),
    ) as number;
    expect(settled(first)).toBeNull();
    late.start();
    await open.bed.clock.advance(0);
    await vi.waitFor(() => expect(settled(first)).not.toBeNull(), { timeout: 5_000 });
    enqueueEffect(
      open.bed.db,
      { kind: "attachment.cleanup", ownerId: "u1", payload: { day: "2026-10-03" } },
      open.bed.clock.now() + 60_000,
    );
    late.outbox.poke();
    await late.stop();
    expect(open.bed.clock.pending()).toBe(0);
  });

  it("start arms only the stall counters on a read-only database, and stop clears them", async () => {
    open = openM10Core(true);
    const early = composeM10Early(open.core);
    const late = composeM10(open.core, early, modules);
    late.start();
    expect(open.bed.clock.pending()).toBe(1);
    await late.stop();
    expect(open.bed.clock.pending()).toBe(0);
  });
});

describe("the mode the usage resume reads (M10R104, W5-R23)", () => {
  it("is the sessions module's effective mode, not the raw session mode", () => {
    const source = readFileSync(fileURLToPath(new URL("./compose-usage.ts", import.meta.url)), "utf8");
    expect(source).toContain("modeOf: modules.sessions.modeOf");
    expect(source).not.toContain("sessionPolicy(ownerId, sessionId).mode");
  });
});
