import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunsService, type RunsService } from "./service.ts";
import { createRunsStore, type RunsStore } from "./store.ts";
import { assistantEnd } from "./testing/events.ts";
import { openRunsBed, type RunsBed } from "./testing/bed.ts";

let bed: RunsBed;
let store: RunsStore;
let service: RunsService;
let counter: number;

beforeEach(() => {
  bed = openRunsBed();
  store = createRunsStore(bed.db);
  counter = 0;
  service = createRunsService({
    store,
    clock: bed.clock,
    logger: bed.logger,
    newId: () => `run-${++counter}`,
    exportRun: () => undefined,
  });
});
afterEach(() => bed.close());

const parent = { id: "s1", ownerId: "u1" };
const childOf = (id: string, parentSessionId = "s1") => ({ id, ownerId: "u1", parentSessionId });
const run = (
  session: { id: string; ownerId: string; parentSessionId?: string },
  cost: number,
  close = true,
) => {
  service.observer.onRecord(session, "run_start", { origin: "user" }, null);
  service.observer.onEvent(session.id, assistantEnd({ cost }));
  if (close) service.observer.onRecord(session, "run_end", { aborted: false }, null);
};

describe("the cost of a parent rolls up its children's (M11R141)", () => {
  it("copies the parent's id to the child's runs", () => {
    run(childOf("c1"), 0.25);
    expect(bed.db.get("SELECT parent_session_id AS p FROM runs WHERE session_id = 'c1'")).toEqual({
      p: "s1",
    });
  });

  it("adds the finished runs of its children to its own", () => {
    run(parent, 0.5);
    run(childOf("c1"), 0.25);
    run(childOf("c2"), 0.125);
    expect(service.port.sessionCost("s1")).toBe(0.875);
  });

  it("is a number for a parent whose only runs are its children's, and null for an unrelated session", () => {
    run(childOf("c1"), 0.25);
    expect(service.port.sessionCost("s1")).toBe(0.25);
    expect(service.port.sessionCost("s9")).toBeNull();
  });

  it("leaves another parent's children out", () => {
    run(parent, 0.5);
    run(childOf("c9", "s2"), 4);
    expect(service.port.sessionCost("s1")).toBe(0.5);
    expect(service.port.sessionCost("s2")).toBe(4);
  });

  it("counts a child's open run as it goes, once, and keeps the child's own cost to the child", () => {
    run(parent, 0.5);
    run(childOf("c1"), 0.25, false);
    expect(service.port.sessionCost("s1")).toBe(0.75);
    expect(service.port.sessionCost("c1")).toBe(0.25);
    service.observer.onRecord(childOf("c1"), "run_end", { aborted: false }, null);
    expect(service.port.sessionCost("s1")).toBe(0.75);
    expect(service.port.sessionCost("c1")).toBe(0.25);
  });

  it("counts a child that is still in its first run when the parent has none", () => {
    run(childOf("c1"), 0.5, false);
    expect(service.port.sessionCost("s1")).toBe(0.5);
  });
});

describe("the billing of a parent rolls up its children's too (review M7)", () => {
  const billed = (
    session: { id: string; ownerId: string; parentSessionId?: string },
    billing: "api" | "subscription",
  ) => {
    service.observer.onRecord(session, "run_start", { origin: "user" }, null);
    service.observer.onRecord(session, "run_end", { aborted: false }, { billing });
  };

  it("reads a child's finished billing as its own", () => {
    billed(childOf("c1"), "subscription");
    expect(service.port.sessionBilling("s1")).toBe("subscription");
    expect(service.port.sessionBilling("c1")).toBe("subscription");
    expect(service.port.sessionBilling("s2")).toBeNull();
  });

  it("is subscription when the parent bills api and a child bills a subscription, and api when all do", () => {
    billed(parent, "api");
    billed(childOf("c1"), "api");
    expect(service.port.sessionBilling("s1")).toBe("api");
    billed(childOf("c2"), "subscription");
    expect(service.port.sessionBilling("s1")).toBe("subscription");
  });

  it("is unknown while only a child's open run exists, as for a session's own open run", () => {
    run(childOf("c1"), 0.5, false);
    expect(service.port.sessionBilling("s1")).toBe("unknown");
  });
});
