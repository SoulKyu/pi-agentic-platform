import { afterEach, describe, expect, it, vi } from "vitest";
import { createDueTimer } from "./due-timer.ts";
import { createScheduler } from "./scheduler.ts";
import { createTriggerStore } from "./store.ts";
import { AGENT, fakeAgentPorts, type FakeAgentPorts } from "./testing/agent-fakes.ts";
import { createRunnerBed, effectContext, type RunnerBed } from "./testing/runner-bed.ts";

const MINUTE = 60_000;
const SCOUT = "scout-3c4d";

let bed: RunnerBed;
let fakes: FakeAgentPorts;
afterEach(() => bed.dispose());

function setup(): void {
  bed = createRunnerBed();
  fakes = fakeAgentPorts(bed.home);
  fakes.add();
  fakes.add(SCOUT, "u1", { name: "Scout" });
  bed.engine.agents.bind(fakes.ports);
}
const timer = () =>
  createDueTimer({
    db: bed.db,
    clock: bed.clock,
    logger: bed.logger,
    store: bed.engine.store,
    outbox: bed.outbox,
  });
const remind = (inMinutes: number, agentId = AGENT) =>
  bed.engine.agentTasks.remind({
    ownerId: "u1",
    agentId,
    note: `in ${inMinutes}`,
    notBefore: bed.clock.now() + inMinutes * MINUTE,
    requestedBy: null,
    tainted: false,
    sessionId: "s-atlas",
  }).taskId;
const dueEffects = () =>
  bed.db.all<{ dedup_key: string; payload: string; status: string }>(
    "SELECT dedup_key, payload, status FROM outbox WHERE kind = 'task.start' AND dedup_key LIKE 'due:%' ORDER BY id",
  );
const start = () => bed.engine.runner.handleStart({ taskId: "any" }, effectContext());
const stateOf = (id: string) =>
  bed.db.get<{ state: string }>("SELECT state FROM tasks WHERE id = $id", { id })?.state;

describe("the timer for tasks that wait for a time (M11R81)", () => {
  it("arms nothing when no task waits", () => {
    setup();
    timer().start();
    expect(bed.clock.pending()).toBe(0);
  });

  it("sends one start for a reminder at its time, not a millisecond before, and then rests", async () => {
    setup();
    const id = remind(30);
    const due = timer();
    due.start();
    expect(bed.clock.pending()).toBe(1);
    await bed.clock.advance(30 * MINUTE - 1);
    expect(dueEffects()).toEqual([]);
    await bed.clock.advance(1);
    expect(dueEffects()).toEqual([
      { dedup_key: `due:${id}`, payload: JSON.stringify({ taskId: id }), status: "pending" },
    ]);
    expect(bed.clock.pending()).toBe(0);
    due.stop();
  });

  it("goes to the earliest first and arms the next one after it", async () => {
    setup();
    const late = remind(60);
    const early = remind(30, SCOUT);
    const due = timer();
    due.start();
    await bed.clock.advance(30 * MINUTE);
    expect(dueEffects().map((effect) => effect.dedup_key)).toEqual([`due:${early}`]);
    expect(bed.clock.pending()).toBe(1);
    await bed.clock.advance(30 * MINUTE);
    expect(dueEffects().map((effect) => effect.dedup_key)).toEqual([`due:${early}`, `due:${late}`]);
    due.stop();
  });

  it("looks again when an earlier task is made after the timer was armed", async () => {
    setup();
    remind(60);
    const due = timer();
    due.start();
    const sooner = remind(15);
    due.refresh();
    expect(bed.clock.pending()).toBe(1);
    await bed.clock.advance(15 * MINUTE);
    expect(dueEffects().map((effect) => effect.dedup_key)).toEqual([`due:${sooner}`]);
    due.stop();
  });

  it("sends the start of a task whose time came while the daemon was down, once however often it looks", async () => {
    setup();
    const id = remind(10);
    await bed.clock.advance(20 * MINUTE);
    const due = timer();
    due.start();
    due.refresh();
    due.refresh();
    expect(dueEffects().map((effect) => effect.dedup_key)).toEqual([`due:${id}`]);
    due.stop();
  });

  it("sends nothing for a task cancelled before its time", async () => {
    setup();
    const id = remind(30);
    const due = timer();
    due.start();
    await bed.engine.runner.cancel("u1", id);
    await bed.clock.advance(30 * MINUTE);
    expect(dueEffects()).toEqual([]);
    due.stop();
  });

  it("stops: no timer is left and a later time sends nothing", async () => {
    setup();
    remind(30);
    const due = timer();
    due.start();
    due.stop();
    expect(bed.clock.pending()).toBe(0);
    await bed.clock.advance(60 * MINUTE);
    expect(dueEffects()).toEqual([]);
    due.refresh();
    expect(bed.clock.pending()).toBe(0);
  });

  it("a pass that fails is logged and the next one is tried in a minute", async () => {
    setup();
    const failing = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("db busy");
      })
      .mockReturnValue(null);
    const due = createDueTimer({
      db: bed.db,
      clock: bed.clock,
      logger: bed.logger,
      store: { dueQueued: () => [], nextNotBefore: failing },
      outbox: bed.outbox,
    });
    due.start();
    expect(bed.logs.some((line) => line.msg === "due_tasks_arm_failed")).toBe(true);
    expect(bed.clock.pending()).toBe(1);
    await bed.clock.advance(MINUTE);
    expect(failing).toHaveBeenCalledTimes(2);
    expect(bed.clock.pending()).toBe(0);
    due.stop();
  });

  it("a release that throws is logged by name and never reaches the caller", () => {
    setup();
    const due = createDueTimer({
      db: bed.db,
      clock: bed.clock,
      logger: bed.logger,
      store: {
        dueQueued: () => {
          throw new Error("db busy");
        },
        nextNotBefore: () => null,
      },
      outbox: bed.outbox,
    });
    expect(() => due.start()).not.toThrow();
    expect(bed.logs.some((line) => line.msg === "due_tasks_failed")).toBe(true);
    due.stop();
  });
});

describe("a task that waits for a time in the admission and the scheduler", () => {
  function withScheduler(readOnly = false) {
    const scheduler = createScheduler({
      db: bed.db,
      clock: bed.clock,
      logger: bed.logger,
      triggers: bed.triggers,
      store: createTriggerStore(bed.db),
      fire: bed.engine.fire,
      readOnly,
      outbox: bed.outbox,
      tasks: bed.engine.store,
    });
    bed.engine.agentTasks.onDelayed(() => scheduler.armDue());
    return scheduler;
  }

  it("the runner skips it until its time and starts the others meanwhile", async () => {
    setup();
    const waiting = remind(30);
    const asked = bed.engine.agentTasks.delegate({
      ownerId: "u1",
      requesterId: AGENT,
      targetId: SCOUT,
      text: "now",
      isolated: false,
    }).taskId;
    expect(await start()).toEqual({ outcome: "done" });
    expect(stateOf(asked)).toBe("running");
    expect(stateOf(waiting)).toBe("queued");
    expect(await start()).toEqual({ outcome: "done" });
    expect(stateOf(waiting)).toBe("queued");
    await bed.clock.advance(30 * MINUTE);
    await start();
    expect(stateOf(waiting)).toBe("running");
  });

  it("a reminder neither fires at once nor never: the scheduler's timer sends its start at its time, and the runner starts it", async () => {
    setup();
    const scheduler = withScheduler();
    scheduler.start();
    const id = remind(30);
    expect(bed.clock.pending()).toBe(1);
    await start();
    expect(stateOf(id)).toBe("queued");
    await bed.clock.advance(30 * MINUTE);
    expect(dueEffects()).toHaveLength(1);
    await start();
    expect(stateOf(id)).toBe("running");
    expect(bed.sessions.prompt).toHaveBeenCalledTimes(1);
    scheduler.stop();
    const timers = bed.clock.pending();
    remind(10);
    expect(bed.clock.pending()).toBe(timers);
  });

  it("a reminder made after the scheduler started arms the timer without a restart", async () => {
    setup();
    const scheduler = withScheduler();
    scheduler.start();
    expect(bed.clock.pending()).toBe(0);
    remind(45);
    expect(bed.clock.pending()).toBe(1);
    scheduler.stop();
  });

  it("arms nothing in read-only mode", () => {
    setup();
    const scheduler = withScheduler(true);
    scheduler.start();
    remind(45);
    expect(bed.clock.pending()).toBe(0);
    scheduler.stop();
  });
});
