import { afterEach, describe, expect, it } from "vitest";
import { createAuditService } from "./service.ts";
import { createAuditStore } from "./store.ts";
import { createAuditBed } from "./testing/bed.ts";

let current: ReturnType<typeof createAuditBed> | undefined;
afterEach(() => current?.dispose());

const entry = (decision: string) => ({
  kind: "call",
  toolCallId: "c1",
  tool: "bash",
  category: "exec",
  decision,
  reason: "answer: once",
  stages: [{ stage: "01", outcome: "pass" }],
  args: "ls",
});

function bed() {
  current = createAuditBed();
  const store = createAuditStore(current.db);
  return { store, service: createAuditService({ store, clock: current.clock, logger: current.logger }) };
}

describe("a call row names the credential that answered its question (M4 of the M5 final review)", () => {
  it.each([
    ["token", "tok1"],
    ["user", "dev1"],
  ] as const)("records %s %s as the row's actor", (actor, actorId) => {
    const { service, store } = bed();
    service.fromWorker({ id: "s1", ownerId: "u1" }, entry("approved"), {
      containment: "none",
      answeredBy: { actor, actorId },
    });
    expect(store.page({ ownerId: "u1", limit: 1 })[0]).toMatchObject({
      kind: "call",
      decision: "approved",
      actor,
      actorId,
    });
  });

  it("leaves the worker as the actor when nobody answered", () => {
    const { service, store } = bed();
    service.fromWorker({ id: "s1", ownerId: "u1" }, entry("approved"), { containment: "none" });
    expect(store.page({ ownerId: "u1", limit: 1 })[0]).toMatchObject({ actor: "worker", actorId: null });
  });

  it("ignores an answerer on a row that is not a call", () => {
    const { service, store } = bed();
    const result = {
      kind: "result",
      toolCallId: "c",
      tool: "web",
      stages: [],
      redactions: 0,
      external: false,
    };
    service.fromWorker({ id: "s1", ownerId: "u1" }, result, {
      containment: "none",
      answeredBy: { actor: "token", actorId: "tok1" },
    });
    expect(store.page({ ownerId: "u1", limit: 1 })[0]).toMatchObject({ actor: "worker" });
  });
});
