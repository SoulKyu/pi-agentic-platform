import { nextOccurrence, parseRrule, type ParsedRrule } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clock } from "../../kernel/clock.ts";
import type { FireInput, FireResult } from "./fire.ts";
import { createScheduler, LATE_MS } from "./scheduler.ts";
import { createTriggerStore } from "./store.ts";
import { type AutomationBed, createAutomationBed, parsedInput } from "./testing/bed.ts";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const QUARTER = "FREQ=MINUTELY;INTERVAL=15";
const HOURLY = "FREQ=HOURLY";

let bed: AutomationBed;
beforeEach(() => {
  bed = createAutomationBed();
});
afterEach(() => bed.dispose());

type FireCall = { triggerId: string; revision: number; input: FireInput };

function setup(options: { readOnly?: boolean; clock?: Clock; triggers?: () => unknown } = {}) {
  const calls: FireCall[] = [];
  const fire = vi.fn((triggerId: string, revision: number, input: FireInput): FireResult => {
    calls.push({ triggerId, revision, input });
    return { verdict: "fired" };
  });
  const store = createTriggerStore(bed.db);
  const scheduler = createScheduler({
    db: bed.db,
    clock: options.clock ?? bed.clock,
    logger: bed.logger,
    triggers: bed.triggers,
    store,
    fire,
    readOnly: options.readOnly ?? false,
  });
  bed.onTriggerChange(() => scheduler.refresh());
  return { scheduler, fire, calls, store };
}

function addSchedule(
  rrule: string,
  options: { catchUp?: "skip" | "once"; enabled?: boolean; name?: string } = {},
) {
  const { trigger } = bed.triggers.create(
    bed.owner(),
    parsedInput({
      name: options.name ?? "Nightly check",
      enabled: options.enabled ?? true,
      source: { type: "schedule", rrule, timezone: "UTC", catchUp: options.catchUp ?? "skip" },
      execution: { cwd: bed.folder },
      prompt: "Look at the repository and report.",
    }),
  );
  return trigger;
}

const nextFireOf = (id: string): number | null =>
  bed.db.get<{ next_fire_at: number | null }>("SELECT next_fire_at FROM triggers WHERE id = $id", { id })
    ?.next_fire_at ?? null;
const journal = (id: string) =>
  bed.db.all<{ verdict: string; detail: string | null; count: number }>(
    "SELECT verdict, detail, count FROM trigger_fires WHERE trigger_id = $id ORDER BY id",
    { id },
  );
const ruleOf = (text: string): ParsedRrule => {
  const parsed = parseRrule(text);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.rule;
};
const hourFloor = (at: number): number => Math.floor(at / HOUR) * HOUR;

describe("arming", () => {
  it("arms one timer for the earliest trigger and arms nothing without a schedule", async () => {
    const { scheduler, calls, store } = setup();
    scheduler.start();
    expect(bed.clock.pending()).toBe(0);
    const late = addSchedule(QUARTER, { name: "late" });
    const early = addSchedule(QUARTER, { name: "early" });
    const now = bed.clock.now();
    store.setNextFire("u1", late.id, now + 20 * MINUTE);
    store.setNextFire("u1", early.id, now + 5 * MINUTE);
    scheduler.refresh();
    expect(bed.clock.pending()).toBe(1);
    await bed.clock.advance(5 * MINUTE - 1);
    expect(calls).toHaveLength(0);
    await bed.clock.advance(1);
    expect(calls.map((call) => call.triggerId)).toEqual([early.id]);
    scheduler.stop();
  });

  it("computes the first occurrence of a trigger saved while running, from now", () => {
    const { scheduler } = setup();
    scheduler.start();
    const trigger = addSchedule(QUARTER);
    expect(nextFireOf(trigger.id)).toBe(nextOccurrence(ruleOf(QUARTER), "UTC", bed.clock.now()));
    expect(bed.clock.pending()).toBe(1);
    scheduler.stop();
  });

  it("recomputes a saved trigger from now and disarms a disabled one", () => {
    const { scheduler, store } = setup();
    scheduler.start();
    const trigger = addSchedule(QUARTER);
    store.setNextFire("u1", trigger.id, bed.clock.now() + 1);
    const view = bed.triggers.view(bed.owner(), trigger.id);
    bed.triggers.update(bed.owner(), {
      triggerId: trigger.id,
      baseRevision: view.revision,
      input: parsedInput({
        name: "Nightly check",
        enabled: true,
        source: { type: "schedule", rrule: HOURLY, timezone: "UTC" },
        execution: { cwd: bed.folder },
        prompt: "Look at the repository and report.",
      }),
    });
    expect(nextFireOf(trigger.id)).toBe(nextOccurrence(ruleOf(HOURLY), "UTC", bed.clock.now()));
    bed.triggers.setEnabled(bed.owner(), trigger.id, false);
    expect(nextFireOf(trigger.id)).toBeNull();
    expect(bed.clock.pending()).toBe(0);
    scheduler.stop();
  });

  it("never fires a disabled trigger, and re-enabling computes from now", async () => {
    const { scheduler, calls } = setup();
    scheduler.start();
    const trigger = addSchedule(QUARTER, { enabled: false });
    await bed.clock.advance(HOUR);
    expect(calls).toHaveLength(0);
    bed.triggers.setEnabled(bed.owner(), trigger.id, true);
    expect(nextFireOf(trigger.id)).toBe(nextOccurrence(ruleOf(QUARTER), "UTC", bed.clock.now()));
    scheduler.stop();
  });

  it("stop cancels the timer and later changes arm nothing", () => {
    const { scheduler } = setup();
    scheduler.start();
    addSchedule(QUARTER);
    expect(bed.clock.pending()).toBe(1);
    scheduler.stop();
    expect(bed.clock.pending()).toBe(0);
    addSchedule(QUARTER, { name: "after stop" });
    expect(bed.clock.pending()).toBe(0);
  });

  it("read-only mode arms nothing and fires nothing", async () => {
    const trigger = addSchedule(QUARTER);
    createTriggerStore(bed.db).setNextFire("u1", trigger.id, bed.clock.now() - HOUR);
    const { scheduler, calls } = setup({ readOnly: true });
    scheduler.start();
    await bed.clock.advance(HOUR);
    expect(bed.clock.pending()).toBe(0);
    expect(calls).toHaveLength(0);
    expect(journal(trigger.id)).toEqual([]);
  });
});

describe("a tick", () => {
  it("fires every trigger due at the same instant from one tick, with the revision it read", async () => {
    const { scheduler, calls, store } = setup();
    scheduler.start();
    const triggers = ["a", "b", "c"].map((name) => addSchedule(QUARTER, { name }));
    const at = bed.clock.now() + 5 * MINUTE;
    for (const trigger of triggers) store.setNextFire("u1", trigger.id, at);
    scheduler.refresh();
    await bed.clock.advance(5 * MINUTE);
    expect(calls.map((call) => call.triggerId).sort()).toEqual(triggers.map((t) => t.id).sort());
    expect(calls.every((call) => call.revision === triggers[0]?.revision)).toBe(true);
    expect(calls[0]?.input).toMatchObject({
      source: "schedule",
      payload: null,
      detail: null,
      gated: true,
      gates: { exemptDisabled: false },
      ownerId: "u1",
    });
  });

  it("recomputes from now after a fire and fires again at the next occurrence", async () => {
    const { scheduler, calls, store } = setup();
    scheduler.start();
    const trigger = addSchedule(QUARTER);
    store.setNextFire("u1", trigger.id, bed.clock.now() + 5 * MINUTE);
    scheduler.refresh();
    await bed.clock.advance(5 * MINUTE);
    expect(calls).toHaveLength(1);
    expect(nextFireOf(trigger.id)).toBe(nextOccurrence(ruleOf(QUARTER), "UTC", bed.clock.now()));
    await bed.clock.advance(HOUR);
    expect(calls).toHaveLength(5);
    scheduler.stop();
  });

  it("a trigger saved or disabled after the tick read it is the fire path's `changed`, not the scheduler's", async () => {
    const { scheduler, fire, store } = setup();
    scheduler.start();
    const trigger = addSchedule(QUARTER);
    store.setNextFire("u1", trigger.id, bed.clock.now() + 5 * MINUTE);
    scheduler.refresh();
    await bed.clock.advance(5 * MINUTE);
    expect(fire).toHaveBeenCalledWith(trigger.id, trigger.revision, expect.any(Object));
  });
});

describe("a late wake (M10R61)", () => {
  const stalled = (): Clock => ({
    ...bed.clock,
    setTimeout: (fn, ms) => bed.clock.setTimeout(fn, ms + 10 * MINUTE),
  });

  it("with skip, a tick 10 minutes late writes one `missed` line and fires nothing", async () => {
    const { scheduler, calls, store } = setup({ clock: stalled() });
    scheduler.start();
    const trigger = addSchedule(QUARTER, { catchUp: "skip" });
    const due = nextOccurrence(ruleOf(QUARTER), "UTC", bed.clock.now()) as number;
    store.setNextFire("u1", trigger.id, due);
    scheduler.refresh();
    await bed.clock.advance(25 * MINUTE);
    expect(calls).toHaveLength(0);
    expect(journal(trigger.id)).toEqual([{ verdict: "missed", detail: "1", count: 1 }]);
    expect(nextFireOf(trigger.id)).toBe(due + 15 * MINUTE);
    scheduler.stop();
  });

  it("with once, the same tick fires once, marked as a catch-up", async () => {
    const { scheduler, calls, store } = setup({ clock: stalled() });
    scheduler.start();
    const trigger = addSchedule(QUARTER, { catchUp: "once" });
    store.setNextFire("u1", trigger.id, nextOccurrence(ruleOf(QUARTER), "UTC", bed.clock.now()));
    scheduler.refresh();
    await bed.clock.advance(25 * MINUTE);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input.detail).toBe("catch-up");
    expect(journal(trigger.id)).toEqual([]);
    scheduler.stop();
  });

  it("an occurrence exactly LATE_MS late still fires normally", async () => {
    const { scheduler, calls, store } = setup({
      clock: { ...bed.clock, setTimeout: (fn, ms) => bed.clock.setTimeout(fn, ms + LATE_MS) },
    });
    scheduler.start();
    const trigger = addSchedule(QUARTER);
    store.setNextFire("u1", trigger.id, bed.clock.now() + 5 * MINUTE);
    scheduler.refresh();
    await bed.clock.advance(5 * MINUTE + LATE_MS);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input.detail).toBeNull();
    scheduler.stop();
  });
});

describe("missed fires at boot (M10R62)", () => {
  it("3 hours ago with skip: one `missed` line with the count, nothing fired, then the next from now", () => {
    const trigger = addSchedule(HOURLY, { catchUp: "skip" });
    const { scheduler, calls, store } = setup();
    store.setNextFire("u1", trigger.id, hourFloor(bed.clock.now()) - 3 * HOUR);
    scheduler.start();
    expect(calls).toHaveLength(0);
    expect(journal(trigger.id)).toEqual([{ verdict: "missed", detail: "4", count: 1 }]);
    expect(nextFireOf(trigger.id)).toBe(nextOccurrence(ruleOf(HOURLY), "UTC", bed.clock.now()));
    scheduler.stop();
  });

  it("3 hours ago with once: one fire now, detail catch-up", () => {
    const trigger = addSchedule(HOURLY, { catchUp: "once" });
    const { scheduler, calls, store } = setup();
    store.setNextFire("u1", trigger.id, hourFloor(bed.clock.now()) - 3 * HOUR);
    scheduler.start();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input.detail).toBe("catch-up");
    expect(journal(trigger.id)).toEqual([]);
    scheduler.stop();
  });

  it("20 hours ago with once: the last miss is older than 12 hours, so it is a `missed` line", () => {
    const missedAt = hourFloor(bed.clock.now()) - 20 * HOUR;
    const hour = new Date(missedAt).getUTCHours();
    const trigger = addSchedule(`FREQ=DAILY;BYHOUR=${hour}`, { catchUp: "once" });
    const { scheduler, calls, store } = setup();
    store.setNextFire("u1", trigger.id, missedAt);
    scheduler.start();
    expect(calls).toHaveLength(0);
    expect(journal(trigger.id)).toEqual([{ verdict: "missed", detail: "1", count: 1 }]);
    scheduler.stop();
  });

  it("an occurrence 1 minute late at boot fires normally, even with skip", () => {
    const trigger = addSchedule(QUARTER, { catchUp: "skip" });
    const { scheduler, calls, store } = setup();
    store.setNextFire("u1", trigger.id, bed.clock.now() - MINUTE);
    scheduler.start();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input.detail).toBeNull();
    scheduler.stop();
  });

  it("a miss that lasted longer than the counting cap says so without walking the whole downtime", () => {
    const trigger = addSchedule("FREQ=MINUTELY;INTERVAL=5", { catchUp: "skip" });
    const { scheduler, calls, store } = setup();
    store.setNextFire("u1", trigger.id, bed.clock.now() - 30 * 24 * HOUR);
    scheduler.start();
    expect(calls).toHaveLength(0);
    expect(journal(trigger.id)).toEqual([{ verdict: "missed", detail: "1000+", count: 1 }]);
    scheduler.stop();
  });

  it("a restart never fires an occurrence twice, even when the first fire threw", async () => {
    const trigger = addSchedule(QUARTER);
    const first = setup();
    first.store.setNextFire("u1", trigger.id, bed.clock.now() + 5 * MINUTE);
    first.scheduler.start();
    first.fire.mockImplementationOnce(() => {
      throw new Error("crash during the fire");
    });
    await bed.clock.advance(5 * MINUTE);
    expect(first.fire).toHaveBeenCalledTimes(1);
    expect(bed.logs.some((line) => line.msg === "scheduler_trigger_failed")).toBe(true);
    first.scheduler.stop();
    const second = setup();
    second.scheduler.start();
    expect(second.fire).not.toHaveBeenCalled();
    expect(journal(trigger.id)).toEqual([]);
    second.scheduler.stop();
  });

  it("a restart right after a fire does not fire it again", async () => {
    const trigger = addSchedule(QUARTER);
    const first = setup();
    first.store.setNextFire("u1", trigger.id, bed.clock.now() + 5 * MINUTE);
    first.scheduler.start();
    await bed.clock.advance(5 * MINUTE);
    first.scheduler.stop();
    expect(first.fire).toHaveBeenCalledTimes(1);
    const second = setup();
    second.scheduler.start();
    expect(second.fire).not.toHaveBeenCalled();
    second.scheduler.stop();
  });
});

describe("a failing store", () => {
  it("is logged and the timer is armed again", async () => {
    const trigger = addSchedule(QUARTER);
    let broken = true;
    const calls: string[] = [];
    const scheduler = createScheduler({
      db: bed.db,
      clock: bed.clock,
      logger: bed.logger,
      triggers: {
        listEnabled: () => {
          if (broken) throw new Error("database is locked");
          return bed.triggers.listEnabled();
        },
      },
      store: createTriggerStore(bed.db),
      fire: (id) => {
        calls.push(id);
        return { verdict: "fired" };
      },
      readOnly: false,
    });
    scheduler.start();
    expect(bed.logs.some((line) => line.msg === "scheduler_failed")).toBe(true);
    expect(bed.clock.pending()).toBe(1);
    broken = false;
    createTriggerStore(bed.db).setNextFire("u1", trigger.id, bed.clock.now() + MINUTE);
    await bed.clock.advance(60_000);
    expect(calls).toEqual([trigger.id]);
    scheduler.stop();
  });

  it("one trigger that throws does not stop the others", async () => {
    const bad = addSchedule(QUARTER, { name: "bad" });
    const good = addSchedule(QUARTER, { name: "good" });
    const { scheduler, calls, fire, store } = setup();
    fire.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    for (const id of [bad.id, good.id]) store.setNextFire("u1", id, bed.clock.now() - MINUTE);
    scheduler.start();
    expect(fire).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(1);
    scheduler.stop();
  });
});
