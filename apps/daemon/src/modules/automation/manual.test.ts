import { AutomationSettings } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createManual } from "./manual.ts";
import { manualInput, parsedInput } from "./testing/bed.ts";
import { createRunnerBed, type RunnerBed } from "./testing/runner-bed.ts";

let bed: RunnerBed;
afterEach(() => bed.dispose());

function setup(options: { realRuns?: boolean } = {}) {
  bed = createRunnerBed(options);
  const manual = createManual({
    db: bed.db,
    clock: bed.clock,
    logger: bed.logger,
    fire: bed.engine.fire,
    triggers: bed.triggers,
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

describe("a stored precheck (M10R63, B6)", () => {
  const withPrecheck = () =>
    bed.trigger(parsedInput({ ...manualInput(bed.folder), execution: { cwd: bed.folder, precheck: "df" } }));

  it("is refused precheck_removed, journaled once per cause, and spawns nothing", async () => {
    const manual = setup();
    const trigger = withPrecheck();
    for (let again = 0; again < 3; again += 1)
      expect(await manual.fire(bed.owner(), trigger.id, undefined)).toEqual({
        verdict: "error",
        detail: "precheck_removed",
      });
    expect(lines()).toEqual([{ verdict: "error", detail: "precheck_removed", source: "manual", count: 3 }]);
    expect(bed.tasks()).toEqual([]);
  });

  it("is refused for a token too, and a trigger without one still fires", async () => {
    const manual = setup();
    const trigger = withPrecheck();
    expect((await manual.fire(bed.token(), trigger.id, undefined)).verdict).toBe("error");
    const plain = bed.trigger();
    expect((await manual.fire(bed.owner(), plain.id, undefined)).verdict).toBe("fired");
  });
});
