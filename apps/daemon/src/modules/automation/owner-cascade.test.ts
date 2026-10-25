import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAutomationOwnerCascade } from "./owner-cascade.ts";
import { createTriggerStore } from "./store.ts";
import { type AutomationBed, createAutomationBed } from "./testing/bed.ts";

let bed: AutomationBed;
afterEach(() => bed.dispose());

const id = (n: number) => `0b1c2d3e-0b0${n}-4000-8000-00000000000${n}`;

function trigger(triggerId: string, ownerId: string, projectId: string | null): void {
  bed.db.run(
    `INSERT INTO triggers (id, owner_id, name, enabled, source_type, config, cwd, project_id, created_at, updated_at)
     VALUES ($triggerId, $ownerId, $triggerId, 1, 'webhook', '{}', '/boxes/x/project', $projectId, 1, 1)`,
    { triggerId, ownerId, projectId },
  );
  mkdirSync(bed.secretsDir, { recursive: true });
  writeFileSync(join(bed.secretsDir, `${triggerId}.key`), "secret");
}

describe("automation owner cascade (A5b)", () => {
  it("cancels the owner's active tasks and removes every trigger of theirs with its secret; another owner's stay", async () => {
    bed = createAutomationBed();
    trigger(id(1), "m1", "p-box");
    trigger(id(2), "m1", null);
    trigger(id(3), "u1", "p-box");
    bed.db.run(
      `INSERT INTO tasks (id, owner_id, trigger_id, origin, state, cwd, prompt, tainted, policy, title, max_run_ms, created_at)
       VALUES ('k-run', 'm1', $trigger, 'manual', 'running', '/boxes/x/project', 'p', 0, '{}', 't', 60000, 1)`,
      { trigger: id(1) },
    );
    const cancelled: string[] = [];
    const changes: string[] = [];
    const cascade = createAutomationOwnerCascade(
      { db: bed.db, config: { home: bed.home } },
      bed.logger,
      createTriggerStore(bed.db),
      { cancel: async (_owner, taskId) => void cancelled.push(taskId) },
      (change) => void changes.push(change.triggerId),
    );
    expect(await cascade.removeAll("m1")).toEqual({ triggers: 2 });
    expect(cancelled).toEqual(["k-run"]);
    expect(changes.sort()).toEqual([id(1), id(2)]);
    expect(bed.db.all("SELECT id FROM triggers")).toEqual([{ id: id(3) }]);
    expect(existsSync(join(bed.secretsDir, `${id(1)}.key`))).toBe(false);
    expect(existsSync(join(bed.secretsDir, `${id(3)}.key`))).toBe(true);
    expect(await cascade.removeAll("m1")).toEqual({ triggers: 0 });
  });
});
