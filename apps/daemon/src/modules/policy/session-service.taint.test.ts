import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { policyV2Rpc } from "./rpc.ts";
import { createSessionPolicyService } from "./session-service.ts";
import { createSessionPolicyStore } from "./session-store.ts";
import { createSettingsPolicyStore } from "./settings-store.ts";
import { sessionPolicyBed as bedOf, type SessionPolicyBedParts } from "./testing/bed.ts";

const make = ({ db, clock, logger, audit, sessionOwner }: SessionPolicyBedParts) => {
  const service = createSessionPolicyService({
    sessions: createSessionPolicyStore(db),
    settings: createSettingsPolicyStore(db),
    clock,
    logger,
    audit,
    sessionOwner,
  });
  return { service, rpc: policyV2Rpc(service) };
};

let current: ReturnType<typeof bedOf<ReturnType<typeof make>["service"], ReturnType<typeof make>["rpc"]>>;
beforeEach(() => {
  current = bedOf(make);
});
afterEach(() => current.dispose());

describe("taint reported with the worker's epoch (M5R60)", () => {
  it("ignores a report observed before a clear: a lower epoch and the pre-clear epoch", () => {
    const { service, changes } = current;
    expect(service.markTainted("u1", "s1", 0)).toBe(true);
    service.clearTaint(testCaller(), "s1");
    service.clearTaint(testCaller(), "s1");
    expect(service.sessionPolicy("u1", "s1").taint).toEqual({ tainted: false, epoch: 2 });
    const told = changes.length;
    expect(service.markTainted("u1", "s1", 0)).toBe(false);
    expect(service.markTainted("u1", "s1", 1)).toBe(false);
    expect(service.sessionPolicy("u1", "s1").taint).toEqual({ tainted: false, epoch: 2 });
    expect(changes).toHaveLength(told);
  });

  it("ignores the pre-clear epoch after a single clear", () => {
    const { service } = current;
    service.markTainted("u1", "s1", 0);
    service.clearTaint(testCaller(), "s1");
    expect(service.markTainted("u1", "s1", 0)).toBe(false);
    expect(service.sessionPolicy("u1", "s1").taint).toEqual({ tainted: false, epoch: 1 });
  });

  it("accepts a report from a worker that received the new epoch", () => {
    const { service } = current;
    service.markTainted("u1", "s1", 0);
    service.clearTaint(testCaller(), "s1");
    expect(service.markTainted("u1", "s1", 1)).toBe(true);
    expect(service.sessionPolicy("u1", "s1").taint).toEqual({ tainted: true, epoch: 1 });
  });

  it("raises without an epoch on the audit fallback path, even after a clear", () => {
    const { service } = current;
    service.clearTaint(testCaller(), "s1");
    expect(service.markTainted("u1", "s1")).toBe(true);
    expect(service.sessionPolicy("u1", "s1").taint).toEqual({ tainted: true, epoch: 1 });
  });
});

describe("inherit never lowers an epoch", () => {
  it("takes the source's mode and taint but keeps the epoch an existing target row has", () => {
    const { service } = current;
    service.markTainted("u1", "s1", 0);
    service.setSessionMode(testCaller(), "s1", "supervised");
    service.clearTaint(testCaller(), "s2");
    service.clearTaint(testCaller(), "s2");
    service.inherit("u1", "s1", "s2");
    expect(service.sessionPolicy("u1", "s2")).toEqual({
      mode: "supervised",
      explicit: true,
      taint: { tainted: true, epoch: 2 },
    });
  });
});

describe("failures around a mutation", () => {
  it("gives not_found for every call while the owner lookup is not bound yet", () => {
    const { db, clock, logger } = current;
    const service = createSessionPolicyService({
      sessions: createSessionPolicyStore(db),
      settings: createSettingsPolicyStore(db),
      clock,
      logger,
      audit: { append: () => {}, fromWorker: () => null },
      sessionOwner: () => null,
    });
    expect(() => service.markTainted("u1", "s1", 0)).toThrow(new PapError("not_found"));
    expect(() => service.inherit("u1", "s1", "s2")).toThrow(new PapError("not_found"));
    expect(() => service.setSessionMode(testCaller(), "s1", "read-only")).toThrow(new PapError("not_found"));
    expect(() => service.clearTaint(testCaller(), "s1")).toThrow(new PapError("not_found"));
  });

  it("leaves the mutation done, and the listeners told, when the audit port throws", () => {
    const { db, clock, logger } = current;
    const told: string[] = [];
    const service = createSessionPolicyService({
      sessions: createSessionPolicyStore(db),
      settings: createSettingsPolicyStore(db),
      clock,
      logger,
      audit: {
        append: () => {
          throw new Error("audit down");
        },
        fromWorker: () => null,
      },
      sessionOwner: () => "u1",
    });
    service.onSessionChange((_owner, sessionId) => void told.push(sessionId));
    expect(() => service.setSessionMode(testCaller(), "s1", "read-only")).toThrow("audit down");
    expect(service.sessionPolicy("u1", "s1").mode).toBe("read-only");
    service.markTainted("u1", "s1", 0);
    expect(() => service.clearTaint(testCaller(), "s1")).toThrow("audit down");
    expect(service.sessionPolicy("u1", "s1").taint).toEqual({ tainted: false, epoch: 1 });
    expect(told).toEqual(["s1", "s1", "s1"]);
  });
});
