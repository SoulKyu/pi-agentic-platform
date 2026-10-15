import { afterEach, describe, expect, it } from "vitest";
import { parsedInput } from "./testing/bed.ts";
import { createRunnerBed, fireInput, type RunnerBed } from "./testing/runner-bed.ts";

const KEY1 = "a".repeat(64);
const KEY2 = "b".repeat(64);
const KEY9 = "c".repeat(64);
let bed: RunnerBed;
afterEach(() => bed.dispose());

const hook = (source: Record<string, unknown> = {}) => {
  const trigger = bed.trigger(
    parsedInput({
      name: "Alert hook",
      enabled: true,
      source: { type: "webhook", ...source },
      execution: { cwd: bed.folder },
      prompt: "An alert fired: {{payload}}",
    }),
  );
  return trigger;
};
const delivery = (overrides: Parameters<typeof fireInput>[0] = {}) =>
  fireInput({
    source: "webhook",
    payload: { text: "disk full", source: "alertmanager" },
    dedupKey: KEY1,
    gates: { exemptDisabled: false },
    ...overrides,
  });
const journal = () =>
  bed.db.all<{ verdict: string; count: number }>("SELECT verdict, count FROM trigger_fires ORDER BY id");

describe("the webhook gates of the fire transaction", () => {
  it("refuses a delivery whose alerts are all resolved when onResolved is skip, and runs it when it is run", () => {
    bed = createRunnerBed();
    const skip = hook();
    expect(bed.engine.fire(skip.id, skip.revision, delivery({ allResolved: true }))).toEqual({
      verdict: "resolved",
    });
    expect(bed.tasks()).toEqual([]);
    expect(journal()).toEqual([{ verdict: "resolved", count: 1 }]);
    const run = hook({ onResolved: "run" });
    expect(bed.engine.fire(run.id, run.revision, delivery({ allResolved: true })).verdict).toBe("fired");
  });

  it("refuses the same key again within the window with dedup, one task, and reopens it after the window", async () => {
    bed = createRunnerBed();
    const trigger = hook({ dedupMinutes: 5 });
    expect(bed.engine.fire(trigger.id, trigger.revision, delivery()).verdict).toBe("fired");
    await bed.clock.advance(5 * 60_000 - 1);
    expect(bed.engine.fire(trigger.id, trigger.revision, delivery()).verdict).toBe("dedup");
    expect(bed.tasks()).toHaveLength(1);
    expect(bed.engine.fire(trigger.id, trigger.revision, delivery({ dedupKey: KEY2 })).verdict).toBe("fired");
    await bed.clock.advance(1);
    expect(bed.engine.fire(trigger.id, trigger.revision, delivery()).verdict).toBe("fired");
    expect(bed.tasks()).toHaveLength(3);
  });

  it("does not dedup a manual fire, another trigger, or a key that only a refusal carried", () => {
    bed = createRunnerBed();
    const one = hook();
    const two = hook();
    bed.engine.fire(one.id, one.revision, delivery());
    expect(bed.engine.fire(two.id, two.revision, delivery()).verdict).toBe("fired");
    expect(
      bed.engine.fire(one.id, one.revision, fireInput({ dedupKey: KEY1, source: "manual" })).verdict,
    ).toBe("fired");
    const paused = hook();
    bed.settings.value = { ...bed.settings.value, paused: true };
    bed.engine.fire(paused.id, paused.revision, delivery({ dedupKey: KEY9 }));
    bed.settings.value = { ...bed.settings.value, paused: false };
    expect(bed.engine.fire(paused.id, paused.revision, delivery({ dedupKey: KEY9 })).verdict).toBe("fired");
  });

  it("keeps the dedup window across a storm of refusals (a fired line is not trimmed away)", () => {
    bed = createRunnerBed();
    const trigger = hook({ dedupMinutes: 1_440 });
    bed.engine.fire(trigger.id, trigger.revision, delivery());
    for (let index = 0; index < 600; index += 1)
      bed.engine.fire(
        trigger.id,
        trigger.revision,
        delivery({ dedupKey: `${index}`.padStart(64, "0"), allResolved: true }),
      );
    expect(bed.engine.fire(trigger.id, trigger.revision, delivery()).verdict).toBe("dedup");
  });

  it("orders the gates: paused before resolved, resolved before dedup", () => {
    bed = createRunnerBed();
    const trigger = hook();
    bed.engine.fire(trigger.id, trigger.revision, delivery());
    expect(bed.engine.fire(trigger.id, trigger.revision, delivery({ allResolved: true })).verdict).toBe(
      "resolved",
    );
    bed.settings.value = { ...bed.settings.value, paused: true };
    expect(bed.engine.fire(trigger.id, trigger.revision, delivery({ allResolved: true })).verdict).toBe(
      "paused",
    );
  });
});
