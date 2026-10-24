import { AutomationSettings } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createScheduler } from "./scheduler.ts";
import { createTriggerStore } from "./store.ts";
import { parsedInput } from "./testing/bed.ts";
import { createRunnerBed, type RunnerBed } from "./testing/runner-bed.ts";

const MINUTE = 60_000;
let bed: RunnerBed;
afterEach(() => bed.dispose());

function setup() {
  bed = createRunnerBed();
  const scheduler = createScheduler({
    db: bed.db,
    clock: bed.clock,
    logger: bed.logger,
    triggers: bed.triggers,
    store: createTriggerStore(bed.db),
    fire: bed.engine.fire,
    readOnly: false,
  });
  bed.onTriggerChange(() => scheduler.refresh());
  scheduler.start();
  bed.triggers.create(
    bed.owner(),
    parsedInput({
      name: "Nightly check",
      enabled: true,
      source: { type: "schedule", rrule: "FREQ=MINUTELY;INTERVAL=15", timezone: "UTC", catchUp: "skip" },
      execution: { cwd: bed.folder, precheck: "check.sh" },
      prompt: "Report",
    }),
  );
  return scheduler;
}
const journal = () =>
  bed.db.all<{ verdict: string; detail: string | null; source: string; count: number }>(
    "SELECT verdict, detail, source, count FROM trigger_fires ORDER BY id",
  );
const taskCount = () => bed.db.all("SELECT 1 FROM tasks").length;

describe("a scheduled trigger that still holds a precheck (B6)", () => {
  it("is refused as precheck_removed, once per cause, and starts no task", async () => {
    const scheduler = setup();
    await bed.clock.advance(15 * MINUTE);
    await bed.clock.advance(15 * MINUTE);
    expect(journal()).toEqual([
      { verdict: "error", detail: "precheck_removed", source: "schedule", count: 2 },
    ]);
    expect(taskCount()).toBe(0);
    scheduler.stop();
  });

  it("does not need the pause or the budget to refuse it", async () => {
    const scheduler = setup();
    bed.settings.value = AutomationSettings.parse({ paused: true });
    await bed.clock.advance(15 * MINUTE);
    expect(journal().map((line) => line.detail)).toEqual(["precheck_removed"]);
    scheduler.stop();
  });
});
