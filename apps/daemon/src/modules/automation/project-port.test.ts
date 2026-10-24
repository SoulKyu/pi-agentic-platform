import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createAutomationProjectPort } from "./project-port.ts";
import { createTriggerStore } from "./store.ts";
import { type AutomationBed, createAutomationBed } from "./testing/bed.ts";
import type { TriggerChanged } from "./triggers.ts";

let bed: AutomationBed;
afterEach(() => bed.dispose());

const BOX = "p-box";
const T1 = "0b1c2d3e-0b01-4000-8000-000000000001";
const T2 = "0b1c2d3e-0b02-4000-8000-000000000002";
const T3 = "0b1c2d3e-0b03-4000-8000-000000000003";
const OTHER = "p-other";

function trigger(id: string, projectId: string): void {
  bed.db.run(
    `INSERT INTO triggers (id, owner_id, name, enabled, source_type, config, cwd, project_id, created_at, updated_at)
     VALUES ($id, 'u1', $id, 1, 'webhook', '{}', '/boxes/x/project', $projectId, 1, 1)`,
    { id, projectId },
  );
  mkdirSync(bed.secretsDir, { recursive: true });
  writeFileSync(join(bed.secretsDir, `${id}.key`), "secret");
}
function task(id: string, triggerId: string, state: string): void {
  bed.db.run(
    `INSERT INTO tasks (id, owner_id, trigger_id, origin, state, cwd, prompt, tainted, policy, title, max_run_ms, created_at, ended_at)
     VALUES ($id, 'u1', $triggerId, 'manual', $state, '/boxes/x/project', 'p', 0, '{}', 't', 60000, 1, $endedAt)`,
    { id, triggerId, state, endedAt: state === "done" ? 2 : null },
  );
}

function world(failCancel?: PapError) {
  bed = createAutomationBed();
  trigger(T1, BOX);
  trigger(T2, BOX);
  trigger(T3, OTHER);
  task("k-run", T1, "running");
  task("k-queued", T2, "queued");
  task("k-done", T1, "done");
  task("k-other", T3, "running");
  const cancelled: string[] = [];
  const changes: TriggerChanged[] = [];
  const port = createAutomationProjectPort(
    { db: bed.db, config: { home: bed.home } },
    bed.logger,
    createTriggerStore(bed.db),
    {
      cancel: async (_owner, taskId) => {
        cancelled.push(taskId);
        if (failCancel) throw failCancel;
      },
    },
    (change) => void changes.push(change),
  );
  return { port, cancelled, changes };
}

describe("automation project port", () => {
  it("counts a project's triggers", () => {
    const { port } = world();
    expect(port.count("u1", BOX)).toBe(2);
    expect(port.count("u2", BOX)).toBe(0);
  });

  it("cancels the project's active tasks, then removes its triggers and their secrets", async () => {
    const { port, cancelled, changes } = world();
    expect(await port.removeProject("u1", BOX)).toEqual({ triggers: 2 });
    expect([...cancelled].sort()).toEqual(["k-queued", "k-run"]);
    expect(changes.map((change) => change.triggerId).sort()).toEqual([T1, T2]);
    expect(bed.db.all("SELECT id FROM triggers")).toEqual([{ id: T3 }]);
    expect(readFileOrNull(T1)).toBeNull();
    expect(readFileOrNull(T3)).toBe("secret");
  });

  it("goes on when a task moved on by itself meanwhile", async () => {
    const { port } = world(new PapError("conflict"));
    expect(await port.removeProject("u1", BOX)).toEqual({ triggers: 2 });
  });

  it("stops at a cancel that fails otherwise, with the triggers still there", async () => {
    const { port } = world(new PapError("internal"));
    await expect(port.removeProject("u1", BOX)).rejects.toMatchObject({ code: "internal" });
    expect(port.count("u1", BOX)).toBe(2);
  });
});

function readFileOrNull(id: string): string | null {
  try {
    return readFileSync(join(bed.secretsDir, `${id}.key`), "utf8");
  } catch {
    return null;
  }
}
