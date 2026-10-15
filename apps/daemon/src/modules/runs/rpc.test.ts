import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { runsRpc } from "./rpc.ts";
import { createRunsService, type RunsService } from "./service.ts";
import { createRunsStore } from "./store.ts";
import { openRunsBed, type RunsBed } from "./testing/bed.ts";

let bed: RunsBed;
let service: RunsService;
beforeEach(() => {
  bed = openRunsBed();
  service = createRunsService({
    store: createRunsStore(bed.db),
    clock: bed.clock,
    logger: bed.logger,
    newId: () => "r1",
    exportRun: () => {},
  });
});
afterEach(() => bed.close());

const context = (userId: string) => ({
  caller: testCaller({ userId }),
  connectionId: "c",
  openSubscription: () => "",
  closeSubscription: () => {},
});

describe("usage.summary", () => {
  it("answers the caller's own runs, in the zone the setting names", async () => {
    service.observer.onRecord({ id: "s1", ownerId: "u1" }, "run_start", { origin: "user" }, null);
    service.observer.onRecord({ id: "s1", ownerId: "u1" }, "run_end", { aborted: false }, null);
    const zones: string[] = [];
    const rpc = runsRpc(service.port, (ownerId) => {
      zones.push(ownerId);
      return "Europe/Paris";
    });
    const mine = await rpc["usage.summary"]({ range: "today" }, context("u1"));
    expect(mine).toMatchObject({ timeZone: "Europe/Paris", totals: { runs: 1 } });
    expect(zones).toEqual(["u1"]);
    const theirs = await rpc["usage.summary"]({ range: "today" }, context("u2"));
    expect(theirs.totals).toEqual({ costUsd: 0, tokens: 0, runs: 0 });
  });
});
