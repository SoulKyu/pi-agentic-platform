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

const TASK = { mode: "supervised", tools: ["read", "grep"], taintedAt: 7 } as const;

describe("a task session's policy (M10R30)", () => {
  it("writes mode, list, taint and the unattended flag together and tells the listeners once", () => {
    const { service, changes } = current;
    service.setTaskPolicy("u1", "s1", TASK);
    expect(service.sessionPolicy("u1", "s1")).toEqual({
      mode: "supervised",
      explicit: true,
      taint: { tainted: true, epoch: 0 },
      toolAllowlist: ["read", "grep"],
      unattended: true,
      recorded: true,
    });
    expect(changes).toEqual(["u1:s1"]);
  });

  it("answers no list, attended and not recorded for a session that is not a task", () => {
    expect(current.service.sessionPolicy("u1", "s1")).toMatchObject({
      toolAllowlist: null,
      unattended: false,
      recorded: false,
    });
  });

  it("keeps an earlier taint when the task starts clean, and never lowers one", () => {
    const { service } = current;
    service.markTainted("u1", "s1");
    service.setTaskPolicy("u1", "s1", { ...TASK, taintedAt: null });
    expect(service.sessionPolicy("u1", "s1").taint.tainted).toBe(true);
  });

  it("refuses another owner's session", () => {
    expect(() => current.service.setTaskPolicy("u2", "s1", TASK)).toThrow(new PapError("not_found"));
    expect(() => current.service.endTaskPolicy("u2", "s1")).toThrow(new PapError("not_found"));
    expect(() => current.service.clearTaskPolicy("u2", "s1")).toThrow(new PapError("not_found"));
  });

  it("copies the list on a fork or clone and never the unattended flag", () => {
    const { service } = current;
    service.setTaskPolicy("u1", "s1", TASK);
    service.inherit("u1", "s1", "s2");
    expect(service.sessionPolicy("u1", "s2")).toMatchObject({
      mode: "supervised",
      toolAllowlist: ["read", "grep"],
      unattended: false,
    });
  });

  it("refuses full-access and follow-default while the task runs, whatever the owner default", () => {
    const { service, changes } = current;
    service.setTaskPolicy("u1", "s1", TASK);
    changes.length = 0;
    expect(() => service.setSessionMode(testCaller(), "s1", "full-access")).toThrow(
      new PapError("session_busy"),
    );
    expect(() => service.setSessionMode(testCaller(), "s1", null)).toThrow(new PapError("session_busy"));
    expect(service.sessionPolicy("u1", "s1")).toMatchObject({ mode: "supervised", explicit: true });
    expect(changes).toEqual([]);
    service.setSessionMode(testCaller(), "s1", "read-only");
    expect(service.sessionPolicy("u1", "s1").mode).toBe("read-only");
  });

  it("accepts full-access once the task ended, the list staying until it is lifted", () => {
    const { service } = current;
    service.setTaskPolicy("u1", "s1", TASK);
    service.endTaskPolicy("u1", "s1");
    service.setSessionMode(testCaller(), "s1", "full-access");
    expect(service.sessionPolicy("u1", "s1")).toMatchObject({
      mode: "full-access",
      toolAllowlist: ["read", "grep"],
      unattended: false,
    });
  });

  it("refuses to lift the list while unattended, lifts it after the end, and tells each change once", () => {
    const { service, changes } = current;
    service.setTaskPolicy("u1", "s1", TASK);
    expect(() => service.clearTaskPolicy("u1", "s1")).toThrow();
    expect(service.sessionPolicy("u1", "s1").toolAllowlist).toEqual(["read", "grep"]);
    service.endTaskPolicy("u1", "s1");
    service.clearTaskPolicy("u1", "s1");
    expect(service.sessionPolicy("u1", "s1")).toMatchObject({ toolAllowlist: null, unattended: false });
    expect(changes).toEqual(["u1:s1", "u1:s1", "u1:s1"]);
  });
});
