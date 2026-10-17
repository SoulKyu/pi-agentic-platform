import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunsService, type RunsService } from "./service.ts";
import { createRunsStore } from "./store.ts";
import { assistantEnd } from "./testing/events.ts";
import { openRunsBed, type RunsBed } from "./testing/bed.ts";

let bed: RunsBed;
let service: RunsService;
let counter: number;
beforeEach(() => {
  bed = openRunsBed();
  counter = 0;
  service = createRunsService({
    store: createRunsStore(bed.db),
    clock: bed.clock,
    logger: bed.logger,
    newId: () => `run-${++counter}`,
    exportRun: () => undefined,
  });
});
afterEach(() => bed.close());

const run = (id: string, taskId: string | null, cost: number, close: boolean) => {
  if (taskId !== null) service.port.expectOrigin(id, { origin: "subagent", taskId });
  service.observer.onRecord({ id, ownerId: "u1" }, "run_start", { origin: "user" }, null);
  service.observer.onEvent(id, assistantEnd({ cost }));
  if (close) service.observer.onRecord({ id, ownerId: "u1" }, "run_end", { aborted: false }, null);
};

describe("spentByTask (M11R141): what a task's runs cost since a moment", () => {
  it("adds the task's finished runs and its runs in flight, children included, and no other task's", () => {
    const since = bed.clock.now();
    run("parent", "t1", 0.5, true);
    run("child-a", "t1", 0.25, true);
    run("child-b", "t1", 0.125, false);
    run("other", "t2", 9, false);
    run("owner", null, 9, false);
    expect(service.port.spentByTask("u1", "t1", since)).toBe(0.875);
    expect(service.port.spentByTask("u1", "t2", since)).toBe(9);
    expect(service.port.spentByTask("u2", "t1", since)).toBe(0);
  });

  it("leaves out the runs that ended before the moment", async () => {
    run("old", "t1", 3, true);
    await bed.clock.advance(1_000);
    const since = bed.clock.now();
    run("new", "t1", 0.5, false);
    expect(service.port.spentByTask("u1", "t1", since)).toBe(0.5);
  });
});
