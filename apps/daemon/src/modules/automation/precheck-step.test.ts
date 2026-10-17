import { AutomationSettings } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type PrecheckPort, createPrecheckStep } from "./precheck-step.ts";
import type { TriggerRecord } from "./triggers.ts";
import { manualInput, parsedInput } from "./testing/bed.ts";
import { createRunnerBed, type RunnerBed } from "./testing/runner-bed.ts";

let bed: RunnerBed;
afterEach(() => bed.dispose());

function setup(run?: PrecheckPort["run"]) {
  bed = createRunnerBed();
  const spawn = vi.fn<PrecheckPort["run"]>(
    run ?? (async () => ({ verdict: "pass", exitCode: 0, durationMs: 4, output: "ok" })),
  );
  const step = createPrecheckStep({
    db: bed.db,
    clock: bed.clock,
    logger: bed.logger,
    settings: { automation: (ownerId) => bed.settings.owners.get(ownerId) ?? bed.settings.value },
    gates: bed.engine.gates,
    triggers: bed.triggers,
    precheck: { run: spawn },
  });
  const view = bed.trigger(
    parsedInput({
      ...manualInput(bed.folder),
      execution: { cwd: bed.folder, precheck: "check.sh", env: ["A"] },
    }),
  );
  return { step, spawn, trigger: recordOf(view.id) };
}
const recordOf = (id: string): TriggerRecord => bed.triggers.get("u1", id) as TriggerRecord;
const lines = () =>
  bed.db.all<{ verdict: string; detail: string | null; source: string; count: number }>(
    "SELECT verdict, detail, source, count FROM trigger_fires ORDER BY id",
  );
const how = { source: "schedule", gated: true, origin: "scheduler" } as const;

describe("the precheck step (M10R70)", () => {
  it("passes the command, the resolved folder, the variable names and the origin, and hands back the output", async () => {
    const { step, spawn, trigger } = setup();
    expect(await step.run(trigger, how)).toEqual({ kind: "go", precheck: "ok" });
    expect(spawn).toHaveBeenCalledWith({
      command: "check.sh",
      cwd: trigger.cwd,
      env: ["A"],
      triggerId: trigger.id,
      origin: "scheduler",
    });
    expect(lines()).toEqual([]);
  });

  it("journals a skip with the first line of the output as the reason, and answers a closed exit detail", async () => {
    const { step, trigger } = setup(async () => ({
      verdict: "skip",
      exitCode: 1,
      durationMs: 1,
      output: "",
      detail: "nothing new",
    }));
    expect(await step.run(trigger, how)).toEqual({
      kind: "stop",
      verdict: "precheck",
      detail: "nothing new",
      answer: "exit 1",
    });
    expect(lines()).toEqual([{ verdict: "precheck", detail: "nothing new", source: "schedule", count: 1 }]);
    await step.run(trigger, how);
    expect(lines()).toEqual([{ verdict: "precheck", detail: "nothing new", source: "schedule", count: 2 }]);
  });

  it("journals an error with the fixed detail of the port", async () => {
    const { step, trigger } = setup(async () => ({
      verdict: "error",
      exitCode: 7,
      durationMs: 1,
      output: "",
      detail: "precheck exit 7",
    }));
    expect(await step.run(trigger, how)).toMatchObject({
      kind: "stop",
      verdict: "error",
      detail: "precheck exit 7",
    });
    expect(lines()).toEqual([{ verdict: "error", detail: "precheck exit 7", source: "schedule", count: 1 }]);
  });

  it("answers an error for a port that throws, and never writes the thrown text", async () => {
    const { step, trigger } = setup(async () => {
      throw new Error("secret-token-in-message");
    });
    expect(await step.run(trigger, how)).toMatchObject({
      kind: "stop",
      verdict: "error",
      detail: "precheck error",
    });
    expect(JSON.stringify(lines())).not.toContain("secret-token");
  });

  it("runs nothing for a trigger without a command", async () => {
    const { step, spawn } = setup();
    const plain = recordOf(bed.trigger(manualInput(bed.folder, "Plain")).id);
    expect(await step.run(plain, how)).toEqual({ kind: "go", precheck: null });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("never spawns for a paused owner, whatever the source or the caller", async () => {
    const { step, spawn, trigger } = setup();
    bed.settings.value = AutomationSettings.parse({ paused: true });
    expect(await step.run(trigger, how)).toEqual({ kind: "go", precheck: null });
    expect(await step.run(trigger, { source: "manual", gated: false, origin: "manual" })).toEqual({
      kind: "go",
      precheck: null,
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("never spawns for a gated fire past the budget, but spawns for the owner's own manual fire", async () => {
    const { step, spawn, trigger } = setup();
    bed.settings.value = AutomationSettings.parse({ dailyBudgetUsd: 5 });
    bed.runs.spent.value = 5;
    expect(await step.run(trigger, how)).toEqual({ kind: "go", precheck: null });
    expect(spawn).not.toHaveBeenCalled();
    expect(await step.run(trigger, { source: "manual", gated: false, origin: "manual" })).toEqual({
      kind: "go",
      precheck: "ok",
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("answers a precheck error for a folder that is gone and spawns nothing", async () => {
    const { step, spawn, trigger } = setup();
    const gone = { ...trigger, cwd: `${bed.folder}/missing` };
    expect(await step.run(gone, how)).toMatchObject({
      kind: "stop",
      verdict: "error",
      detail: "invalid_cwd",
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});
