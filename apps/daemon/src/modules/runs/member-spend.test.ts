import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunsService, type RunsService } from "./service.ts";
import { createRunsStore } from "./store.ts";
import { openRunsBed, type RunsBed } from "./testing/bed.ts";
import { assistantEnd } from "./testing/events.ts";

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

type Billing = "api" | "subscription" | "unknown";
const run = (id: string, owner: string, cost: number, billing: Billing | "live", provider = "anthropic") => {
  service.observer.onRecord({ id, ownerId: owner }, "run_start", { origin: "user" }, null);
  service.observer.onEvent(id, assistantEnd({ cost }, { provider }));
  if (billing !== "live")
    service.observer.onRecord(
      { id, ownerId: owner },
      "run_end",
      { aborted: false },
      billing === "unknown" ? null : { billing },
    );
};

describe("the member line (M14 OQ1)", () => {
  it("counts an interactive run (no task) billed api or unknown, finished and in flight", () => {
    run("a", "m1", 1, "api");
    run("b", "m1", 2, "unknown");
    run("c", "m1", 4, "live");
    run("d", "m2", 8, "api");
    expect(service.port.memberSpent("m1", null)).toBe(7);
    expect(service.port.spentToday("m1", null)).toBe(0);
  });

  it("does not count a subscription-billed run, finished or open through the bridge", () => {
    run("a", "m1", 3, "subscription");
    run("b", "m1", 5, "live", "claude-bridge");
    run("c", "m1", 1, "api");
    expect(service.port.memberSpent("m1", null)).toBe(1);
  });

  it("does not count a finished claude-bridge run, whatever the billing says", () => {
    run("a", "m1", 3, "api", "claude-bridge");
    run("b", "m1", 3, "unknown", "claude-bridge");
    run("c", "m1", 1, "api");
    expect(service.port.memberSpent("m1", null)).toBe(1);
  });

  it("restarts at midnight of the zone it is given, the owner's", async () => {
    run("a", "m1", 2, "api");
    // 12:00 UTC: Pacific/Kiritimati (UTC+14) is already at 02:00 the next day, Pacific/Pago_Pago (UTC-11) is at 01:00.
    expect(service.port.memberSpent("m1", "Pacific/Pago_Pago")).toBe(2);
    await bed.clock.advance(13 * 3_600_000);
    expect(service.port.memberSpent("m1", "UTC")).toBe(0);
    expect(service.port.memberSpent("m1", "Pacific/Pago_Pago")).toBe(2);
  });

  it("spentSince counts the same line over a longer span, in flight included (the Users list's 7 days)", async () => {
    run("a", "m1", 1, "api");
    await bed.clock.advance(3 * 24 * 3_600_000);
    run("b", "m1", 2, "unknown");
    run("c", "m1", 4, "live");
    run("d", "m1", 8, "subscription");
    run("e", "m2", 16, "api");
    const week = bed.clock.now() - 7 * 24 * 3_600_000;
    expect(service.port.spentSince("m1", week)).toBe(7);
    expect(service.port.spentSince("m1", bed.clock.now() - 24 * 3_600_000)).toBe(6);
    expect(service.port.spentSince("m2", week)).toBe(16);
  });
});
