import { existsSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { AutomationSettings, type EventFrame, TriggerInput } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeM10, composeM10Early, type M10, type M10Early } from "./compose-m10.ts";
import { assistantEnd } from "./modules/runs/testing/events.ts";
import type { PolicyPort } from "./modules/policy/index.ts";
import type { ProjectsPort } from "./modules/projects/index.ts";
import type { SessionsModule } from "./modules/sessions/index.ts";
import type { SettingsModule } from "./modules/settings/index.ts";
import { testCaller } from "./testing/caller.ts";
import { openM10Core, type M10TestCore } from "./testing/m10-core.ts";

/** JOIN 2: lane A's task runner and lane B's quota resume, the attachment cleanup and the disk floor, composed for real. */
let open: M10TestCore | undefined;
let late: M10 | undefined;
afterEach(async () => {
  await late?.stop();
  late = undefined;
  open?.close();
  open = undefined;
});

const SESSION = { id: "s1", ownerId: "u1" };
const LIMIT_TEXT = "You have hit your usage limit (plus plan). Try again in ~1 min.";
const MINUTE = 60_000;
const DAY = 86_400_000;
const IDLE = "11111111-1111-4111-8111-111111111111";
const RECENT = "22222222-2222-4222-8222-222222222222";

interface Rig {
  readonly early: M10Early;
  readonly m10: M10;
  readonly test: M10TestCore;
  readonly prompts: string[];
  readonly frames: EventFrame[];
  readonly settings: { autoResume: boolean };
}

function rig(options: { autoResume?: boolean } = {}): Rig {
  const test = openM10Core();
  open = test;
  const settings = { autoResume: options.autoResume ?? true };
  const prompts: string[] = [];
  const early = composeM10Early(test.core);
  const modules = {
    auth: { isMember: () => false },
    audit: { port: { append: () => {}, reserve: () => true, fromWorker: () => null } },
    projects: { port: { ensure: () => null } as unknown as ProjectsPort },
    policy: {
      port: {
        scopeOf: (cwd: string) => cwd,
        endTaskPolicy: () => {},
        sessionPolicy: () => ({ mode: "supervised", toolAllowlist: null, recorded: false }),
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
        state: () => ({ archived: false, running: false, needsInput: false }),
        admits: () => true,
        promptPending: () => false,
        lastActivityAt: () => null,
        abort: async () => {},
        release: async () => "released",
        archive: () => {},
        prompt: async ({ text }: { text: string }) => {
          prompts.push(text);
          // The worker accepts the prompt and the run starts: as the owner's own, no origin was expected.
          early.observer.onRecord(SESSION, "run_start", { origin: "user" }, null);
          return "started";
        },
      } as unknown as SessionsModule["automation"],
    },
    settings: {
      port: { automation: () => AutomationSettings.parse({ autoResume: settings.autoResume }) },
    } as unknown as SettingsModule,
  } satisfies Parameters<typeof composeM10>[2];
  const m10 = composeM10(test.core, early, modules);
  late = m10;
  const frames: EventFrame[] = [];
  test.core.hub.open({
    connectionId: "c1",
    sub: "sub1",
    stream: "tasks",
    key: "u1",
    after: undefined,
    send: (frame) => void frames.push(frame),
  });
  return { early, m10, test, prompts, frames, settings };
}

/** A task running in `s1`, then its run ends on a quota limit: the task is limited, the resume planned or not. */
function limitedTask(r: Rig): string {
  const { db, clock } = r.test.bed;
  db.run(
    `INSERT INTO tasks (id, owner_id, origin, state, cwd, prompt, tainted, policy, title, session_id, max_run_ms,
       created_at, started_at)
     VALUES ('task1', 'u1', 'manual', 'running', '/w', 'p', 0, '{}', 'T', 's1', 600000, $now, $now)`,
    { now: clock.now() },
  );
  r.early.runs.port.expectOrigin("s1", { origin: "manual", taskId: "task1" });
  r.early.observer.onRecord(SESSION, "run_start", { origin: "manual" }, null);
  r.early.observer.onEvent(
    "s1",
    assistantEnd({ input: 1, cost: 0.1 }, { stopReason: "error", errorMessage: LIMIT_TEXT }),
  );
  r.early.observer.onRecord(SESSION, "run_end", {}, null);
  return "task1";
}

const stateOf = (r: Rig, id: string) =>
  r.test.bed.db.get<{ state: string }>("SELECT state FROM tasks WHERE id = $id", { id })?.state;
const resumes = (r: Rig) =>
  r.test.bed.db.all<{ status: string }>("SELECT status FROM outbox WHERE kind = 'run.resume'");
const ctx = { caller: testCaller() } as never;

describe("a limited task and its quota resume (JOIN 2)", () => {
  it("shows the reset the run persisted, and Cancel retires the pending resume with the task", async () => {
    const r = rig();
    const id = limitedTask(r);
    expect(stateOf(r, id)).toBe("limited");
    expect(resumes(r)).toEqual([{ status: "pending" }]);
    const view = r.frames.map(
      (frame) => frame.event as { kind: string; task?: { state: string; resetAt: number } },
    );
    expect(view.find((event) => event.task?.state === "limited")?.task?.resetAt).toBe(
      r.test.bed.clock.now() + MINUTE,
    );

    await r.m10.rpc["automation.tasks.cancel"]({ taskId: id }, ctx);

    expect(stateOf(r, id)).toBe("cancelled");
    expect(resumes(r)).toEqual([{ status: "retired" }]);
  });

  it("with auto-resume off, the task stays limited with nothing scheduled, and Cancel still works", async () => {
    const r = rig({ autoResume: false });
    const id = limitedTask(r);
    expect(stateOf(r, id)).toBe("limited");
    expect(resumes(r)).toEqual([]);

    await r.m10.rpc["automation.tasks.cancel"]({ taskId: id }, ctx);

    expect(stateOf(r, id)).toBe("cancelled");
  });

  it("with auto-resume off, Resume now sends the continuation and the task runs again", async () => {
    const r = rig({ autoResume: false });
    const id = limitedTask(r);

    await r.m10.rpc["usage.resumeNow"]({ sessionId: "s1" }, ctx);

    expect(r.prompts).toEqual(["Continue where you left off."]);
    expect(stateOf(r, id)).toBe("running");
  });
});

describe("the daily attachment cleanup (JOIN 2)", () => {
  it("is enqueued by the housekeeping and handled: an idle session's folder goes, a recent one stays", async () => {
    const r = rig();
    const root = join(r.test.core.config.home, "attachments");
    for (const name of [IDLE, RECENT]) mkdirSync(join(root, name), { recursive: true });
    const old = new Date(r.test.bed.clock.now() - 40 * DAY);
    utimesSync(join(root, IDLE), old, old);

    r.m10.start();
    await r.test.bed.clock.advance(60 * MINUTE);
    await r.test.bed.clock.advance(0);

    // The handler walks the folder with real file calls: it settles on the event loop, not on the fake clock.
    await vi.waitFor(() => expect(existsSync(join(root, IDLE))).toBe(false));
    expect(existsSync(join(root, RECENT))).toBe(true);
    await vi.waitFor(() =>
      expect(
        r.test.bed.db.all<{ status: string }>("SELECT status FROM outbox WHERE kind = 'attachment.cleanup'"),
      ).toEqual([{ status: "done" }]),
    );
  });
});

/** A trigger with its own $0.05 budget, and its task that ended `done` in `s1` having cost $0.10 (over that budget). */
function doneTaskOfSpentTrigger(r: Rig, state = "done"): void {
  const { db, clock } = r.test.bed;
  const config = TriggerInput.parse({
    name: "Nightly",
    source: { type: "manual" },
    execution: { cwd: "/w", dailyBudgetUsd: 0.05 },
    prompt: "Report.",
  });
  const now = clock.now();
  db.run(
    `INSERT INTO triggers (id, owner_id, name, enabled, source_type, config, cwd, created_at, updated_at)
     VALUES ('trig1', 'u1', 'Nightly', 1, 'manual', $config, '/w', $now, $now)`,
    { config: JSON.stringify(config), now },
  );
  db.run(
    `INSERT INTO tasks (id, owner_id, trigger_id, origin, state, cwd, prompt, tainted, gated, policy, title, session_id,
       max_run_ms, created_at, started_at, ended_at)
     VALUES ('task1', 'u1', 'trig1', 'schedule', $state, '/w', 'p', 0, 1, '{}', 'T', 's1', 600000, $now, $now,
       CASE WHEN $state IN ('running', 'limited') THEN NULL ELSE $now END)`,
    { now, state },
  );
  db.run(
    `INSERT INTO runs (id, owner_id, session_id, task_id, origin, status, started_at, ended_at, cost_usd)
     VALUES ('run0', 'u1', 's1', 'task1', 'schedule', 'completed', $now, $now, 0.1)`,
    { now },
  );
}

/** Later the owner continues the finished task's session by hand, and that run of theirs hits a quota. */
async function ownerRunLimited(r: Rig): Promise<void> {
  await r.test.bed.clock.advance(MINUTE);
  r.early.observer.onRecord(SESSION, "run_start", { origin: "user" }, null);
  r.early.observer.onEvent(
    "s1",
    assistantEnd({ input: 1, cost: 0.01 }, { stopReason: "error", errorMessage: LIMIT_TEXT }),
  );
  r.early.observer.onRecord(SESSION, "run_end", {}, null);
}

describe("a finished task's session is an ordinary session (final review I1)", () => {
  it.each(["running", "limited"])("taskOf answers the task while it is %s", (state) => {
    const r = rig();
    doneTaskOfSpentTrigger(r, state);
    expect(r.m10.automation.taskOf("u1", "s1")).toMatchObject({ taskId: "task1", overBudget: true });
  });

  it.each(["done", "failed", "cancelled", "interrupted"])(
    "taskOf answers null once the task is %s",
    (state) => {
      const r = rig();
      doneTaskOfSpentTrigger(r, state);
      expect(r.m10.automation.taskOf("u1", "s1")).toBeNull();
    },
  );

  it("the owner's own quota resume is not skipped for the old trigger's budget", async () => {
    const r = rig();
    doneTaskOfSpentTrigger(r);
    await ownerRunLimited(r);
    const skipped: string[] = [];
    r.early.runs.port.onResumeSkipped((_session: string, reason: string) => skipped.push(reason));

    await r.test.bed.clock.advance(3 * MINUTE);
    await r.m10.outbox.drain();

    expect(skipped).toEqual([]);
    expect(r.prompts).toEqual(["Continue where you left off."]);
  });

  it("and its run is not attributed to the old task", async () => {
    const r = rig();
    doneTaskOfSpentTrigger(r);
    r.test.bed.db.run("UPDATE runs SET cost_usd = 0.01 WHERE id = 'run0'");
    await ownerRunLimited(r);

    await r.test.bed.clock.advance(3 * MINUTE);
    await r.m10.outbox.drain();

    const rows = r.test.bed.db.all<{ origin: string; task_id: string | null }>(
      "SELECT origin, task_id FROM runs WHERE session_id = 's1' ORDER BY started_at, id",
    );
    expect(rows.at(-1)).toEqual({ origin: "resume", task_id: null });
  });
});
