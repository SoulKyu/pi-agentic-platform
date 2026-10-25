import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeMemberLine, memberCapOf } from "./compose-boxes-budget.ts";
import { createRunsModule, type RunsService } from "./modules/runs/index.ts";
import { assistantEnd } from "./modules/runs/testing/events.ts";
import { openRunsBed, type RunsBed } from "./modules/runs/testing/bed.ts";
import { boxRow, lateWithBoxes, PROJECT } from "./testing/late-boxes.ts";

const CAP = 5;
const auth = {
  ownerId: () => "o1",
  roleOf: (id: string) => (id === "m1" ? ("member" as const) : id === "o1" ? ("owner" as const) : null),
  budgetOf: (id: string) => (id === "m1" ? CAP : null),
  isDisabled: () => false,
};
let bed: RunsBed;
let runs: RunsService;
beforeEach(() => {
  bed = openRunsBed();
  runs = createRunsModule({ db: bed.db, clock: bed.clock, logger: bed.logger, appendLine: () => undefined });
});
afterEach(() => bed.close());

const line = (timezone: string | null = null) =>
  composeMemberLine({ auth, runs, settings: { automation: () => ({ timezone }) as never } });
/** An interactive run (origin `user`, no task) of the owner's id. */
const chat = (id: string, ownerId: string, cost: number, billing: "api" | "subscription", close = true) => {
  runs.observer.onRecord({ id, ownerId }, "run_start", { origin: "user" }, null);
  runs.observer.onEvent(id, assistantEnd({ cost }));
  if (close) runs.observer.onRecord({ id, ownerId }, "run_end", { aborted: false }, { billing });
};

describe("the member line in a project box's relay policy (RT-02)", () => {
  it("an interactive box session of a member is refused budget once the cap is spent", async () => {
    const memberLine = line();
    const box = lateWithBoxes({ rows: { [PROJECT]: boxRow({ ownerId: "m1" }) }, memberLine });
    chat("a", "m1", 3, "api");
    expect((await box.derived.policyOfProject(PROJECT)).blocked).toBeNull();
    chat("b", "m1", 2, "api", false);
    expect(runs.port.spentToday("m1", null)).toBe(0);
    expect(memberLine.memberSpentToday("m1")).toBe(5);
    expect((await box.derived.policyOfProject(PROJECT)).blocked).toBe("budget");
  });

  it("a subscription-billed run does not count, and the owner is never blocked", async () => {
    const memberLine = line();
    chat("a", "m1", 40, "subscription");
    chat("b", "o1", 400, "api");
    const member = lateWithBoxes({ rows: { [PROJECT]: boxRow({ ownerId: "m1" }) }, memberLine });
    const owner = lateWithBoxes({ rows: { [PROJECT]: boxRow({ ownerId: "o1" }) }, memberLine });
    expect((await member.derived.policyOfProject(PROJECT)).blocked).toBeNull();
    expect((await owner.derived.policyOfProject(PROJECT)).blocked).toBeNull();
    expect(memberLine.over("o1")).toBe(false);
  });

  it("the day is the owner's zone: the member's own zone is never read", () => {
    chat("a", "m1", 5, "api");
    // 12:00 UTC: the owner's zone Pacific/Pago_Pago is still on the same day, UTC+14 has just crossed into the next.
    expect(line("Pacific/Pago_Pago").over("m1")).toBe(true);
    return bed.clock.advance(13 * 3_600_000).then(() => {
      expect(line("UTC").over("m1")).toBe(false);
      expect(line("Pacific/Pago_Pago").over("m1")).toBe(true);
    });
  });

  it("changing the member's own zone does not move their budget day, every gate reads the one seam (R10)", async () => {
    line("Pacific/Pago_Pago");
    // A task run (an automatic one, which the automation gates count) of the member and one of the owner.
    for (const [id, owner] of [
      ["t-m", "m1"],
      ["t-o", "o1"],
    ] as const) {
      runs.port.expectOrigin(id, { origin: "task", taskId: `task-${id}` });
      runs.observer.onRecord({ id, ownerId: owner }, "run_start", { origin: "user" }, null);
      runs.observer.onEvent(id, assistantEnd({ cost: 2 }));
      runs.observer.onRecord({ id, ownerId: owner }, "run_end", { aborted: false }, { billing: "api" });
    }
    await bed.clock.advance(13 * 3_600_000);
    // The owner's zone is Pago_Pago (the same day still): the member's own UTC / UTC+14 cannot restart it.
    expect(runs.port.spentToday("m1", "UTC")).toBe(2);
    expect(runs.port.spentToday("m1", "Pacific/Kiritimati")).toBe(2);
    expect(runs.port.spentTodayOf("m1", "UTC", ["task-t-m"])).toBe(2);
    // The owner reads their own zone.
    expect(runs.port.spentToday("o1", "UTC")).toBe(0);
    expect(runs.port.spentToday("o1", "Pacific/Pago_Pago")).toBe(2);
  });

  it("a member row with no budget falls back to the install default, a non-member has no cap", () => {
    expect(memberCapOf({ ...auth, budgetOf: () => null })("m1")).toBe(5);
    expect(memberCapOf(auth)("o1")).toBeNull();
    expect(memberCapOf(auth)("ghost")).toBeNull();
  });

  it("a policy refresh follows a run end for a project box", () => {
    const refresh = vi.fn();
    const refreshAll = vi.fn();
    const ends: Array<(event: { sessionId: string; ownerId: string }) => void> = [];
    lateWithBoxes({
      rows: { [PROJECT]: boxRow({ ownerId: "m1" }) },
      relay: { refresh, refreshAll },
      runs: {
        onLiveCost: () => () => {},
        onRunEnd: (listener: never) => (ends.push(listener), () => {}),
      } as never,
      cwdOf: (ownerId, sessionId) => (ownerId === "m1" && sessionId === "s1" ? `/boxes/${PROJECT}` : null),
      memberLine: line(),
    });
    ends[0]?.({ sessionId: "s1", ownerId: "m1" });
    expect(refresh).toHaveBeenCalledWith({ kind: "project", id: PROJECT });
    expect(refreshAll).not.toHaveBeenCalled();
    // Over the cap, every box of the member is pushed: the line is shared.
    chat("a", "m1", 6, "api");
    ends[0]?.({ sessionId: "other", ownerId: "m1" });
    expect(refreshAll).toHaveBeenCalledTimes(1);
  });
});
