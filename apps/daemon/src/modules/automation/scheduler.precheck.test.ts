import { AutomationSettings } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type PrecheckPort, createPrecheckStep } from "./precheck-step.ts";
import { createScheduler } from "./scheduler.ts";
import { createTriggerStore } from "./store.ts";
import { parsedInput } from "./testing/bed.ts";
import { createRunnerBed, deferred, type RunnerBed } from "./testing/runner-bed.ts";

const MINUTE = 60_000;
let bed: RunnerBed;
afterEach(() => bed.dispose());

function setup(run: PrecheckPort["run"]) {
  bed = createRunnerBed();
  const spawn = vi.fn<PrecheckPort["run"]>(run);
  const settings = {
    automation: (ownerId: string) => bed.settings.owners.get(ownerId) ?? bed.settings.value,
  };
  const scheduler = createScheduler({
    db: bed.db,
    clock: bed.clock,
    logger: bed.logger,
    triggers: bed.triggers,
    store: createTriggerStore(bed.db),
    fire: bed.engine.fire,
    readOnly: false,
    precheck: createPrecheckStep({
      db: bed.db,
      clock: bed.clock,
      logger: bed.logger,
      settings,
      gates: bed.engine.gates,
      triggers: bed.triggers,
      precheck: { run: spawn },
    }),
  });
  bed.onTriggerChange(() => scheduler.refresh());
  scheduler.start();
  const { trigger } = bed.triggers.create(
    bed.owner(),
    parsedInput({
      name: "Nightly check",
      enabled: true,
      source: { type: "schedule", rrule: "FREQ=MINUTELY;INTERVAL=15", timezone: "UTC", catchUp: "skip" },
      execution: { cwd: bed.folder, precheck: "check.sh" },
      prompt: "Report: {{precheck}}",
    }),
  );
  return { scheduler, spawn, trigger };
}
const journal = () =>
  bed.db.all<{ verdict: string; detail: string | null; source: string }>(
    "SELECT verdict, detail, source FROM trigger_fires ORDER BY id",
  );
const prompts = () => bed.db.all<{ prompt: string; tainted: number }>("SELECT prompt, tainted FROM tasks");

describe("a scheduled fire with a precheck (M10R68, M10R70)", () => {
  it("fires with the fenced output when the precheck passes", async () => {
    const { scheduler, spawn } = setup(async () => ({
      verdict: "pass",
      exitCode: 0,
      durationMs: 3,
      output: "disk ok",
    }));
    await bed.clock.advance(15 * MINUTE);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0]).toMatchObject({ tainted: 1 });
    expect(prompts()[0]?.prompt).toMatch(/<untrusted source="precheck" id="[0-9a-f]{12}">\ndisk ok/);
    scheduler.stop();
  });

  it("journals a skip as precheck with the reason, and starts no task", async () => {
    const { scheduler } = setup(async () => ({
      verdict: "skip",
      exitCode: 1,
      durationMs: 3,
      output: "nothing new",
      detail: "nothing new",
    }));
    await bed.clock.advance(15 * MINUTE);
    expect(journal()).toEqual([{ verdict: "precheck", detail: "nothing new", source: "schedule" }]);
    expect(prompts()).toEqual([]);
    scheduler.stop();
  });

  it("never spawns the precheck when the owner is paused: the fire is refused and journaled as paused", async () => {
    const { scheduler, spawn } = setup(async () => ({
      verdict: "pass",
      exitCode: 0,
      durationMs: 3,
      output: "x",
    }));
    bed.settings.value = AutomationSettings.parse({ paused: true });
    await bed.clock.advance(15 * MINUTE);
    expect(spawn).not.toHaveBeenCalled();
    expect(journal()).toEqual([{ verdict: "paused", detail: null, source: "schedule" }]);
    scheduler.stop();
  });

  it("never spawns it past the budget", async () => {
    const { scheduler, spawn } = setup(async () => ({
      verdict: "pass",
      exitCode: 0,
      durationMs: 3,
      output: "x",
    }));
    bed.settings.value = AutomationSettings.parse({ dailyBudgetUsd: 5 });
    bed.runs.spent.value = 5;
    await bed.clock.advance(15 * MINUTE);
    expect(spawn).not.toHaveBeenCalled();
    expect(journal()).toEqual([{ verdict: "budget", detail: null, source: "schedule" }]);
    scheduler.stop();
  });

  it("fires nothing when the scheduler stops while the precheck runs", async () => {
    const pending = deferred<Awaited<ReturnType<PrecheckPort["run"]>>>();
    const { scheduler, spawn } = setup(() => pending.promise);
    await bed.clock.advance(15 * MINUTE);
    expect(spawn).toHaveBeenCalledTimes(1);
    scheduler.stop();
    pending.resolve({ verdict: "pass", exitCode: 0, durationMs: 3, output: "late" });
    await Promise.resolve();
    await Promise.resolve();
    expect(prompts()).toEqual([]);
    expect(journal()).toEqual([]);
  });
});
