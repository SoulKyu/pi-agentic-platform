import { AutomationSettings, type PrecheckOutcome } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createManual, type PrecheckPort } from "./manual.ts";
import type { PrecheckRun } from "./precheck-step.ts";
import { manualInput, parsedInput } from "./testing/bed.ts";
import { createRunnerBed, type RunnerBed } from "./testing/runner-bed.ts";

let bed: RunnerBed;
afterEach(() => bed.dispose());

const passing: PrecheckOutcome = { verdict: "pass", exitCode: 0, durationMs: 12, output: "disk ok" };
const skipping: PrecheckRun = {
  verdict: "skip",
  exitCode: 1,
  durationMs: 5,
  output: "nothing new",
  detail: "nothing new",
};

function setup(precheck?: PrecheckPort["run"], options: { realRuns?: boolean } = {}) {
  bed = createRunnerBed(options);
  const manual = createManual({
    db: bed.db,
    clock: bed.clock,
    logger: bed.logger,
    fire: bed.engine.fire,
    triggers: bed.triggers,
    settings: { automation: (ownerId) => bed.settings.owners.get(ownerId) ?? bed.settings.value },
    gates: bed.engine.gates,
    ...(precheck ? { precheck: { run: precheck } } : {}),
  });
  return manual;
}
const taskOf = (id: string) =>
  bed.db.get<{ origin: string; gated: number; tainted: number; prompt: string; state: string }>(
    "SELECT origin, gated, tainted, prompt, state FROM tasks WHERE id = $id",
    { id },
  );
const lines = () =>
  bed.db.all<{ verdict: string; detail: string | null; source: string; count: number }>(
    "SELECT verdict, detail, source, count FROM trigger_fires ORDER BY id",
  );
const codeOf = async (work: Promise<unknown>): Promise<string | undefined> =>
  work.then(
    () => undefined,
    (error: { code?: string }) => error.code,
  );

describe("manual fire (M10R63)", () => {
  it("fires the saved trigger even when it is disabled, as the owner's own action (gated = 0)", async () => {
    const manual = setup();
    const trigger = bed.trigger();
    expect(trigger.enabled).toBe(false);
    const result = await manual.fire(bed.owner(), trigger.id, undefined);
    expect(result.verdict).toBe("fired");
    const row = taskOf((result as { taskId: string }).taskId);
    expect(row).toMatchObject({ origin: "manual", gated: 0, tainted: 0, state: "queued" });
    expect(lines()).toEqual([{ verdict: "fired", detail: null, source: "manual", count: 1 }]);
  });

  it("gates a token's fire, and lets a token fire a disabled trigger too", async () => {
    const manual = setup();
    const trigger = bed.trigger();
    const result = await manual.fire(bed.token(), trigger.id, undefined);
    expect(taskOf((result as { taskId: string }).taskId)).toMatchObject({ origin: "manual", gated: 1 });
  });

  it("fences a payload as manual for a manual trigger and as webhook for a webhook trigger, and starts tainted", async () => {
    const manual = setup();
    const plain = bed.trigger(
      parsedInput({ ...manualInput(bed.folder), prompt: "Look at this: {{payload}}" }),
    );
    const hook = bed.webhook();
    const first = (await manual.fire(bed.owner(), plain.id, "disk is full")) as { taskId: string };
    const second = (await manual.fire(bed.owner(), hook.id, "alert text")) as { taskId: string };
    expect(taskOf(first.taskId)?.prompt).toMatch(/<untrusted source="manual" id="[0-9a-f]{12}">/);
    expect(taskOf(first.taskId)).toMatchObject({ tainted: 1 });
    expect(taskOf(second.taskId)?.prompt).toMatch(/<untrusted source="webhook" id="[0-9a-f]{12}">/);
    expect(taskOf(second.taskId)).toMatchObject({ tainted: 1 });
  });

  it("renders {{payload}} empty for a schedule or feed trigger fired without one", async () => {
    const manual = setup();
    const trigger = bed.trigger(
      parsedInput({
        name: "Feed",
        source: { type: "feed", url: "https://example.com/feed.xml" },
        execution: { cwd: bed.folder },
        prompt: "News: [{{payload}}]",
      }),
    );
    const result = (await manual.fire(bed.owner(), trigger.id, undefined)) as { taskId: string };
    expect(taskOf(result.taskId)).toMatchObject({ prompt: "News: []", tainted: 0 });
  });

  it("answers not_found for another owner's trigger and for an unknown one, with no journal line", async () => {
    const manual = setup();
    const trigger = bed.trigger();
    expect(await codeOf(manual.fire(bed.other(), trigger.id, undefined))).toBe("not_found");
    expect(await codeOf(manual.fire(bed.owner(), "nope", undefined))).toBe("not_found");
    expect(lines()).toEqual([]);
  });

  it("answers rate_limited for a full queue", async () => {
    const manual = setup();
    const trigger = bed.trigger();
    for (let queued = 0; queued < 20; queued += 1) await manual.fire(bed.owner(), trigger.id, undefined);
    expect(await codeOf(manual.fire(bed.owner(), trigger.id, undefined))).toBe("rate_limited");
    expect(lines().at(-1)).toMatchObject({ verdict: "queue_full" });
  });

  it("answers automation_paused to a browser and to a token", async () => {
    const manual = setup();
    const trigger = bed.trigger();
    bed.settings.value = AutomationSettings.parse({ paused: true });
    expect(await codeOf(manual.fire(bed.owner(), trigger.id, undefined))).toBe("automation_paused");
    expect(await codeOf(manual.fire(bed.token(), trigger.id, undefined))).toBe("automation_paused");
  });

  it("answers budget_reached to a token past the budget, and fires a browser's", async () => {
    const manual = setup();
    const trigger = bed.trigger();
    bed.settings.value = AutomationSettings.parse({ dailyBudgetUsd: 5 });
    bed.runs.spent.value = 5;
    expect(await codeOf(manual.fire(bed.token(), trigger.id, undefined))).toBe("budget_reached");
    expect((await manual.fire(bed.owner(), trigger.id, undefined)).verdict).toBe("fired");
  });
});

describe("the precheck runs first (M10R63)", () => {
  it("answers a skip as {verdict: precheck, detail}, journals it and starts no task", async () => {
    const run = vi.fn(async () => skipping);
    const manual = setup(run);
    const trigger = bed.trigger(
      parsedInput({ ...manualInput(bed.folder), execution: { cwd: bed.folder, precheck: "exit 1" } }),
    );
    const result = await manual.fire(bed.owner(), trigger.id, undefined);
    expect(result).toEqual({ verdict: "precheck", detail: "exit 1" });
    expect(lines()).toEqual([{ verdict: "precheck", detail: "nothing new", source: "manual", count: 1 }]);
    expect(bed.tasks()).toEqual([]);
  });

  it("collapses repeated skips into one line", async () => {
    const manual = setup(async () => skipping);
    const trigger = bed.trigger(
      parsedInput({ ...manualInput(bed.folder), execution: { cwd: bed.folder, precheck: "exit 1" } }),
    );
    for (let again = 0; again < 3; again += 1) await manual.fire(bed.owner(), trigger.id, undefined);
    expect(lines()).toEqual([{ verdict: "precheck", detail: "nothing new", source: "manual", count: 3 }]);
  });

  it("fences the output of a passing precheck and starts the run tainted", async () => {
    const run = vi.fn(async () => passing);
    const manual = setup(run);
    const trigger = bed.trigger(
      parsedInput({
        ...manualInput(bed.folder),
        execution: { cwd: bed.folder, precheck: "df" },
        prompt: "Disk: {{precheck}}",
      }),
    );
    const result = (await manual.fire(bed.owner(), trigger.id, undefined)) as { taskId: string };
    expect(run).toHaveBeenCalledWith({
      command: "df",
      cwd: trigger.cwd,
      env: [],
      triggerId: trigger.id,
      origin: "manual",
    });
    expect(taskOf(result.taskId)).toMatchObject({ tainted: 1 });
    expect(taskOf(result.taskId)?.prompt).toMatch(/<untrusted source="precheck" id="[0-9a-f]{12}">\ndisk ok/);
  });

  it("strips hidden characters from a manual payload and from a precheck output before they reach the prompt", async () => {
    const hidden = "\u{E0049}\u{E0047}\u202E\u200B\u0007";
    const run = vi.fn(async () => ({ ...passing, output: `disk${hidden} ok` }));
    const manual = setup(run);
    const trigger = bed.trigger(
      parsedInput({
        ...manualInput(bed.folder),
        execution: { cwd: bed.folder, precheck: "df" },
        prompt: "Disk: {{precheck}} Payload: {{payload}}",
      }),
    );
    const result = (await manual.fire(bed.owner(), trigger.id, `pay${hidden}load`)) as { taskId: string };
    const prompt = taskOf(result.taskId)?.prompt ?? "";
    expect(prompt).toContain("\ndisk ok\n");
    expect(prompt).toContain("\npayload\n");
    expect(prompt).not.toMatch(/\p{Cf}/u);
    expect(prompt).not.toContain("\u0007");
  });

  it("answers a precheck that could not run as an error with a closed detail", async () => {
    const manual = setup(async () => ({
      verdict: "error",
      exitCode: null,
      durationMs: 30_000,
      output: "boom",
      detail: "precheck timeout",
    }));
    const trigger = bed.trigger(
      parsedInput({ ...manualInput(bed.folder), execution: { cwd: bed.folder, precheck: "sleep 99" } }),
    );
    const result = await manual.fire(bed.owner(), trigger.id, undefined);
    expect(result).toEqual({ verdict: "error", detail: "precheck timeout" });
    expect(lines()).toEqual([{ verdict: "error", detail: "precheck timeout", source: "manual", count: 1 }]);
  });

  it("does not run a trigger's precheck when it has none", async () => {
    const run = vi.fn(async () => passing);
    const manual = setup(run);
    const trigger = bed.trigger();
    await manual.fire(bed.owner(), trigger.id, undefined);
    expect(run).not.toHaveBeenCalled();
  });

  describe("the pause and the budget come first (ruling 1)", () => {
    const withPrecheck = () =>
      bed.trigger(
        parsedInput({ ...manualInput(bed.folder), execution: { cwd: bed.folder, precheck: "df" } }),
      );

    it("never spawns the precheck of a paused owner, from a browser or a token", async () => {
      const run = vi.fn(async () => passing);
      const manual = setup(run);
      const trigger = withPrecheck();
      bed.settings.value = AutomationSettings.parse({ paused: true });
      expect(await codeOf(manual.fire(bed.owner(), trigger.id, undefined))).toBe("automation_paused");
      expect(await codeOf(manual.fire(bed.token(), trigger.id, undefined))).toBe("automation_paused");
      expect(run).not.toHaveBeenCalled();
      expect(lines()).toEqual([{ verdict: "paused", detail: null, source: "manual", count: 2 }]);
    });

    it("never spawns a token's precheck past the budget, and spawns the owner's own", async () => {
      const run = vi.fn(async () => passing);
      const manual = setup(run);
      const trigger = withPrecheck();
      bed.settings.value = AutomationSettings.parse({ dailyBudgetUsd: 5 });
      bed.runs.spent.value = 5;
      expect(await codeOf(manual.fire(bed.token(), trigger.id, undefined))).toBe("budget_reached");
      expect(run).not.toHaveBeenCalled();
      expect((await manual.fire(bed.owner(), trigger.id, undefined)).verdict).toBe("fired");
      expect(run).toHaveBeenCalledTimes(1);
    });
  });
});
