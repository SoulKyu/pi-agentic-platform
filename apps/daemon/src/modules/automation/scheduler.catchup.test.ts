import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FireInput, FireResult } from "./fire.ts";
import { createScheduler } from "./scheduler.ts";
import { createTriggerStore } from "./store.ts";
import { type AutomationBed, createAutomationBed, parsedInput } from "./testing/bed.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let bed: AutomationBed;
beforeEach(() => {
  bed = createAutomationBed();
});
afterEach(() => bed.dispose());

function boot(rrule: string, catchUp: "skip" | "once", downFor: number) {
  const { trigger } = bed.triggers.create(
    bed.owner(),
    parsedInput({
      name: "Long downtime",
      enabled: true,
      source: { type: "schedule", rrule, timezone: "UTC", catchUp },
      execution: { cwd: bed.folder },
      prompt: "Look at the repository and report.",
    }),
  );
  const store = createTriggerStore(bed.db);
  store.setNextFire("u1", trigger.id, bed.clock.now() - downFor);
  const calls: FireInput[] = [];
  const fire = vi.fn((_id: string, _revision: number, input: FireInput): FireResult => {
    calls.push(input);
    return { verdict: "fired" };
  });
  const scheduler = createScheduler({
    db: bed.db,
    clock: bed.clock,
    logger: bed.logger,
    triggers: bed.triggers,
    store,
    fire,
    readOnly: false,
  });
  scheduler.start();
  scheduler.stop();
  const lines = bed.db.all<{ verdict: string; detail: string | null }>(
    "SELECT verdict, detail FROM trigger_fires WHERE trigger_id = $id",
    { id: trigger.id },
  );
  return { calls, lines };
}

describe("a downtime longer than the counting cap (M10R62)", () => {
  it.each([
    ["FREQ=MINUTELY;INTERVAL=5", 4 * DAY],
    ["FREQ=HOURLY", 60 * DAY],
  ])("%s: once fires once, as the last miss is recent", (rrule, downFor) => {
    const { calls, lines } = boot(rrule, "once", downFor);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.detail).toBe("catch-up");
    expect(lines).toEqual([]);
  });

  it.each([
    ["FREQ=MINUTELY;INTERVAL=5", 4 * DAY],
    ["FREQ=HOURLY", 60 * DAY],
  ])("%s: skip writes one line that says the count is capped", (rrule, downFor) => {
    const { calls, lines } = boot(rrule, "skip", downFor);
    expect(calls).toHaveLength(0);
    expect(lines).toEqual([{ verdict: "missed", detail: "1000+" }]);
  });

  it("once still refuses when the real last miss is older than 12 hours", () => {
    // Daily, 13 hours before the current hour: more than 1000 misses, the last of them 13 to 14 hours ago.
    const hour = (new Date(bed.clock.now()).getUTCHours() + 24 - 13) % 24;
    const { calls, lines } = boot(`FREQ=DAILY;BYHOUR=${hour}`, "once", 1100 * DAY);
    expect(calls).toHaveLength(0);
    expect(lines).toEqual([{ verdict: "missed", detail: "1000+" }]);
  });
});
