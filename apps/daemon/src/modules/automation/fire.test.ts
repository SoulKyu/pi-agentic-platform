import { AUTOMATION_LIMITS, type TriggerInput } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsedInput } from "./testing/bed.ts";
import { createRunnerBed, fireInput, type RunnerBed } from "./testing/runner-bed.ts";

let bed: RunnerBed;
afterEach(() => bed.dispose());

const journal = () =>
  bed.db.all<{ verdict: string; detail: string | null; task_id: string | null; count: number }>(
    "SELECT verdict, detail, task_id, count FROM trigger_fires ORDER BY id",
  );
const taskRows = () =>
  bed.db.all<Record<string, string | number | null>>("SELECT * FROM tasks ORDER BY created_at, id");

describe("fire", () => {
  it("writes the journal row, the task and one task.start effect for the owner in one transaction", () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    const result = bed.engine.fire(trigger.id, trigger.revision, fireInput({ detail: "first line\nsecond" }));
    expect(result).toEqual({ verdict: "fired", taskId: "task-1" });
    expect(journal()).toEqual([{ verdict: "fired", detail: null, task_id: "task-1", count: 1 }]);
    expect(taskRows()).toMatchObject([
      {
        id: "task-1",
        owner_id: "u1",
        trigger_id: trigger.id,
        origin: "manual",
        state: "queued",
        cwd: bed.folder,
        prompt: "Look at the repository and report.",
        tainted: 0,
        gated: 1,
        title: "Nightly check",
        detail: "first line",
        retry_of: null,
        retry_on_interrupt: 0,
        max_run_ms: 20 * 60_000,
        max_run_usd: null,
      },
    ]);
    expect(JSON.parse(String(taskRows()[0]?.policy))).toEqual({
      mode: "auto-accept-edits",
      tools: ["read", "grep", "find", "ls"],
      preset: "read-only",
      env: [],
    });
    expect(bed.db.all("SELECT owner_id, status, payload FROM outbox WHERE kind = 'task.start'")).toEqual([
      { owner_id: "u1", status: "pending", payload: '{"taskId":"task-1"}' },
    ]);
    expect(bed.db.get("SELECT last_fire_at FROM triggers WHERE id = $id", { id: trigger.id })).toEqual({
      last_fire_at: bed.clock.now(),
    });
  });

  it("leaves no task and no effect when the journal insert throws", () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    bed.db.exec(
      "CREATE TRIGGER no_journal BEFORE INSERT ON trigger_fires BEGIN SELECT RAISE(ABORT, 'journal broken'); END",
    );
    expect(() => bed.engine.fire(trigger.id, trigger.revision, fireInput())).toThrow(/journal broken/);
    expect(taskRows()).toEqual([]);
    expect(bed.effects()).toEqual([]);
  });

  it("pokes the outbox after the commit and never inside the transaction", () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    const inside: boolean[] = [];
    vi.spyOn(bed.outbox, "poke").mockImplementation(() => {
      try {
        bed.db.exec("BEGIN IMMEDIATE");
        bed.db.exec("ROLLBACK");
        inside.push(false);
      } catch {
        inside.push(true);
      }
    });
    bed.engine.fire(trigger.id, trigger.revision, fireInput());
    expect(inside).toEqual([false]);
  });

  it("does not poke when nothing was fired", () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    const poke = vi.spyOn(bed.outbox, "poke");
    bed.settings.value = { ...bed.settings.value, paused: true };
    expect(bed.engine.fire(trigger.id, trigger.revision, fireInput()).verdict).toBe("paused");
    expect(poke).not.toHaveBeenCalled();
  });

  it("journals error changed for a stale revision, and writes no task", () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    expect(bed.engine.fire(trigger.id, trigger.revision + 1, fireInput())).toEqual({
      verdict: "error",
      detail: "changed",
    });
    expect(journal()).toEqual([{ verdict: "error", detail: "changed", task_id: null, count: 1 }]);
    expect(taskRows()).toEqual([]);
    expect(bed.effects()).toEqual([]);
  });

  it("answers changed with no journal row for a trigger that is gone", () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    bed.triggers.remove(bed.owner(), trigger.id);
    expect(bed.engine.fire(trigger.id, trigger.revision, fireInput())).toEqual({
      verdict: "error",
      detail: "changed",
    });
    expect(journal()).toEqual([]);
  });

  it("answers changed when the stored config no longer parses", () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    bed.db.run("UPDATE triggers SET config = '{}' WHERE id = $id", { id: trigger.id });
    expect(bed.engine.fire(trigger.id, trigger.revision, fireInput())).toEqual({
      verdict: "error",
      detail: "changed",
    });
    expect(taskRows()).toEqual([]);
  });

  it("refuses a disabled trigger, except for a manual fire", () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    bed.triggers.setEnabled(bed.owner(), trigger.id, false);
    const revision = bed.triggers.get("u1", trigger.id)?.revision ?? 0;
    const refused = bed.engine.fire(
      trigger.id,
      revision,
      fireInput({ source: "webhook", gates: { exemptDisabled: false } }),
    );
    expect(refused).toEqual({ verdict: "disabled" });
    expect(journal()).toEqual([{ verdict: "disabled", detail: null, task_id: null, count: 1 }]);
    expect(
      bed.engine.fire(trigger.id, revision, fireInput({ gates: { exemptDisabled: true } })).verdict,
    ).toBe("fired");
  });

  it("runs the gates in order: disabled before paused before queue_full", () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    bed.triggers.setEnabled(bed.owner(), trigger.id, false);
    const revision = bed.triggers.get("u1", trigger.id)?.revision ?? 0;
    bed.settings.value = { ...bed.settings.value, paused: true };
    const strict = fireInput({ gates: { exemptDisabled: false } });
    expect(bed.engine.fire(trigger.id, revision, strict).verdict).toBe("disabled");
    expect(bed.engine.fire(trigger.id, revision, fireInput()).verdict).toBe("paused");
  });

  it("refuses every source while automation is paused, and journals it", () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    bed.settings.value = { ...bed.settings.value, paused: true };
    expect(bed.engine.fire(trigger.id, trigger.revision, fireInput({ source: "schedule" }))).toEqual({
      verdict: "paused",
    });
    expect(journal()).toEqual([{ verdict: "paused", detail: null, task_id: null, count: 1 }]);
    expect(taskRows()).toEqual([]);
  });

  it("collapses identical refusals into one journal line with a count, and never collapses fired", () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    bed.settings.value = { ...bed.settings.value, paused: true };
    for (let n = 0; n < 3; n++) bed.engine.fire(trigger.id, trigger.revision, fireInput());
    expect(journal()).toEqual([{ verdict: "paused", detail: null, task_id: null, count: 3 }]);
    bed.settings.value = { ...bed.settings.value, paused: false };
    bed.engine.fire(trigger.id, trigger.revision, fireInput());
    bed.engine.fire(trigger.id, trigger.revision, fireInput());
    expect(journal().map((line) => [line.verdict, line.count])).toEqual([
      ["paused", 3],
      ["fired", 1],
      ["fired", 1],
    ]);
  });

  it("keeps at most 500 journal lines per trigger", () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    for (let n = 0; n < AUTOMATION_LIMITS.journalPerTrigger + 3; n++)
      bed.db.run(
        `INSERT INTO trigger_fires (trigger_id, owner_id, source, verdict, count, first_at, last_at)
         VALUES ($id, 'u1', 'manual', 'fired', 1, $at, $at)`,
        { id: trigger.id, at: n },
      );
    bed.settings.value = { ...bed.settings.value, paused: true };
    bed.engine.fire(trigger.id, trigger.revision, fireInput());
    expect(bed.db.get("SELECT count(*) AS n FROM trigger_fires")).toEqual({
      n: AUTOMATION_LIMITS.journalPerTrigger,
    });
    expect(journal().at(-1)?.verdict).toBe("paused");
  });

  it("refuses the 21st queued task of one trigger with queue_full", () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    for (let n = 0; n < AUTOMATION_LIMITS.queuedPerTrigger; n++)
      expect(bed.engine.fire(trigger.id, trigger.revision, fireInput()).verdict).toBe("fired");
    expect(bed.engine.fire(trigger.id, trigger.revision, fireInput())).toEqual({ verdict: "queue_full" });
    expect(taskRows()).toHaveLength(AUTOMATION_LIMITS.queuedPerTrigger);
    expect(bed.effects()).toHaveLength(AUTOMATION_LIMITS.queuedPerTrigger);
    expect(journal().at(-1)).toMatchObject({ verdict: "queue_full", task_id: null });
  });

  it("counts only queued tasks against the limit of a trigger", () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    for (let n = 0; n < AUTOMATION_LIMITS.queuedPerTrigger; n++)
      bed.engine.fire(trigger.id, trigger.revision, fireInput());
    bed.db.run("UPDATE tasks SET state = 'running', started_at = 1 WHERE id = 'task-1'");
    expect(bed.engine.fire(trigger.id, trigger.revision, fireInput()).verdict).toBe("fired");
  });

  it("journals error prompt_too_large for a rendered prompt over the cap, with no task", () => {
    bed = createRunnerBed();
    const emoji = "😀".repeat(80);
    const input: TriggerInput = parsedInput({
      name: emoji,
      source: { type: "manual" },
      execution: { cwd: bed.folder },
      prompt: "{{trigger}}".repeat(1_480),
    });
    const trigger = bed.triggers.create(bed.owner(), input).trigger;
    expect(bed.engine.fire(trigger.id, trigger.revision, fireInput())).toEqual({
      verdict: "error",
      detail: "prompt_too_large",
    });
    expect(journal()).toEqual([{ verdict: "error", detail: "prompt_too_large", task_id: null, count: 1 }]);
    expect(taskRows()).toEqual([]);
    expect(bed.effects()).toEqual([]);
  });

  it("stores gated as given, the taint of a fenced payload and the trigger's limits", () => {
    bed = createRunnerBed();
    const trigger = bed.webhook();
    const fired = bed.engine.fire(
      trigger.id,
      trigger.revision,
      fireInput({
        source: "webhook",
        gated: false,
        payload: { text: "firing HighCPU", source: "alertmanager" },
        gates: { exemptDisabled: false },
      }),
    );
    expect(fired.verdict).toBe("disabled");
    bed.triggers.setEnabled(bed.owner(), trigger.id, true);
    const revision = bed.triggers.get("u1", trigger.id)?.revision ?? 0;
    const again = bed.engine.fire(
      trigger.id,
      revision,
      fireInput({
        source: "webhook",
        gated: false,
        payload: { text: "firing HighCPU", source: "alertmanager" },
        gates: { exemptDisabled: false },
      }),
    );
    expect(again.verdict).toBe("fired");
    expect(taskRows()).toMatchObject([
      { tainted: 1, gated: 0, origin: "webhook", max_run_usd: 1, retry_on_interrupt: 0 },
    ]);
    expect(String(taskRows()[0]?.prompt)).toContain('<untrusted source="alertmanager" id="');
    expect(JSON.parse(String(taskRows()[0]?.policy)).mode).toBe("supervised");
  });

  it("uses the mode the owner chose on a webhook trigger, loose or strict; the default is supervised", () => {
    bed = createRunnerBed();
    const loose = bed.triggers.create(
      bed.owner(),
      parsedInput({
        name: "Loose hook",
        enabled: true,
        source: { type: "webhook" },
        execution: { cwd: bed.folder, mode: "auto-accept-edits" },
        prompt: "{{payload}}",
      }),
    ).trigger;
    const strict = bed.triggers.create(
      bed.owner(),
      parsedInput({
        name: "Strict hook",
        enabled: true,
        source: { type: "webhook" },
        execution: { cwd: bed.folder, mode: "read-only" },
        prompt: "{{payload}}",
      }),
    ).trigger;
    for (const trigger of [loose, strict])
      bed.engine.fire(
        trigger.id,
        trigger.revision,
        fireInput({
          source: "webhook",
          payload: { text: "x", source: "webhook" },
          gates: { exemptDisabled: false },
        }),
      );
    expect(taskRows().map((row) => JSON.parse(String(row.policy)).mode)).toEqual([
      "auto-accept-edits",
      "read-only",
    ]);
  });

  it("emits a task event with a null previous state for the new task", () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    const seen: unknown[] = [];
    bed.engine.events.on((event) => void seen.push(event));
    bed.engine.fire(trigger.id, trigger.revision, fireInput());
    expect(seen).toMatchObject([
      { kind: "task", ownerId: "u1", previous: null, task: { id: "task-1", state: "queued" } },
    ]);
  });
});
