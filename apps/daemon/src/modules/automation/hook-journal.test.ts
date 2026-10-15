import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createHookJournal } from "./hook-journal.ts";
import { createAutomationBed, webhookInput } from "./testing/bed.ts";

const bed = createAutomationBed();
afterEach(() => bed.db.run("DELETE FROM trigger_fires"));
afterAll(() => bed.dispose());

const rows = () =>
  bed.db.all<{ verdict: string; detail: string | null; count: number; first_at: number; last_at: number }>(
    "SELECT verdict, detail, count, first_at, last_at FROM trigger_fires ORDER BY id",
  );
const trigger = bed.triggers.create(bed.owner(), webhookInput(bed.folder)).trigger;
const target = { id: trigger.id, ownerId: "u1" };

describe("the hook journal", () => {
  it("collapses three unauthenticated attempts in a window into one row with a count of 3", () => {
    const journal = createHookJournal({ db: bed.db, clock: bed.clock, logger: bed.logger });
    for (let index = 0; index < 3; index += 1) journal.unauthorized(target, "secret");
    expect(rows()).toMatchObject([{ verdict: "unauthorized", detail: "secret", count: 3 }]);
  });

  it("opens a new row in the next 10-minute window", async () => {
    const journal = createHookJournal({ db: bed.db, clock: bed.clock, logger: bed.logger });
    journal.unauthorized(target, "secret");
    await bed.clock.advance(599_999);
    journal.unauthorized(target, "secret");
    await bed.clock.advance(1);
    journal.unauthorized(target, "secret");
    expect(rows()).toMatchObject([
      { verdict: "unauthorized", count: 2 },
      { verdict: "unauthorized", count: 1 },
    ]);
  });

  it("does not collapse a window onto a refusal of another kind in between", () => {
    const journal = createHookJournal({ db: bed.db, clock: bed.clock, logger: bed.logger });
    journal.unauthorized(target, "secret");
    journal.refused(target, "bad_payload", null);
    journal.unauthorized(target, "secret");
    expect(rows().map((row) => [row.verdict, row.count])).toEqual([
      ["unauthorized", 2],
      ["bad_payload", 1],
    ]);
  });

  it("logs the trigger id and the count, and nothing of the request", () => {
    const journal = createHookJournal({ db: bed.db, clock: bed.clock, logger: bed.logger });
    bed.logs.length = 0;
    journal.unauthorized(target, "hmac");
    journal.unauthorized(target, "hmac");
    const lines = bed.logs.filter((line) => line.msg === "hook_unauthorized");
    expect(lines).toMatchObject([
      { triggerId: trigger.id, count: 1 },
      { triggerId: trigger.id, count: 2 },
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/authorization|signature|secret|body/i);
  });

  it("collapses a repeated refusal and never throws when the trigger is gone", () => {
    const journal = createHookJournal({ db: bed.db, clock: bed.clock, logger: bed.logger });
    journal.refused(target, "throttle", null);
    journal.refused(target, "throttle", null);
    expect(rows()).toMatchObject([{ verdict: "throttle", count: 2 }]);
    expect(() => journal.unauthorized({ id: "gone", ownerId: "u1" }, "secret")).not.toThrow();
    expect(() => journal.refused({ id: "gone", ownerId: "u1" }, "throttle", null)).not.toThrow();
  });
});
