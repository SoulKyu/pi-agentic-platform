import { afterEach, describe, expect, it } from "vitest";
import { composeOutbox } from "./compose-automation.ts";
import { claimEffect, enqueueEffect } from "./kernel/outbox/store.ts";
import { openM10Core, type M10TestCore } from "./testing/m10-core.ts";

let open: M10TestCore;
afterEach(() => open.close());

function leasedTask(test: M10TestCore): number {
  const { db, clock } = test.bed;
  const id = enqueueEffect(
    db,
    { kind: "task.start", ownerId: "u1", payload: { taskId: "t1" } },
    clock.now(),
  ) as number;
  claimEffect(db, id, "task.start", clock.now());
  return id;
}
const statusOf = (test: M10TestCore, id: number) =>
  test.bed.db.get<{ status: string }>("SELECT status FROM outbox WHERE id = $id", { id })?.status;

describe("composeOutbox", () => {
  it("recovers before it returns the outbox: a leased process-bound row is already retired", () => {
    open = openM10Core();
    const id = leasedTask(open);
    const outbox = composeOutbox(open.core);
    expect(statusOf(open, id)).toBe("retired");
    expect(outbox.db).toBe(open.core.db);
  });

  it("runs nothing and arms nothing on a read-only database", () => {
    open = openM10Core(true);
    const id = leasedTask(open);
    const outbox = composeOutbox(open.core);
    outbox.start();
    expect(statusOf(open, id)).toBe("leased");
    expect(open.bed.clock.pending()).toBe(0);
  });
});
