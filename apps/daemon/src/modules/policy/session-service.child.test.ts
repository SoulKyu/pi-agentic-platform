import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

const CHILD = { mode: "auto-accept-edits", tools: ["read", "grep"], taintedAt: 7 } as const;

describe("a subagent child's policy (M11R136)", () => {
  it("stores mode, list and taint together, attended, and tells the listeners once", () => {
    const { service, changes } = current;
    service.setChildPolicy("u1", "s1", CHILD);
    expect(service.sessionPolicy("u1", "s1")).toEqual({
      mode: "auto-accept-edits",
      explicit: true,
      taint: { tainted: true, epoch: 0 },
      toolAllowlist: ["read", "grep"],
      unattended: false,
      recorded: true,
    });
    expect(changes).toEqual(["u1:s1"]);
  });

  it("stores no list at all when the profile names none, still attended", () => {
    current.service.setChildPolicy("u1", "s1", { mode: "supervised", tools: null, taintedAt: null });
    expect(current.service.sessionPolicy("u1", "s1")).toMatchObject({
      mode: "supervised",
      toolAllowlist: null,
      unattended: false,
      taint: { tainted: false },
    });
  });

  it("refuses an empty list or a name that is not a tool name, and writes nothing", () => {
    for (const tools of [[], ["../etc"], ["a b"]])
      expect(() => current.service.setChildPolicy("u1", "s1", { ...CHILD, tools })).toThrow(
        new PapError("bad_request"),
      );
    expect(current.service.sessionPolicy("u1", "s1").recorded).toBe(false);
    expect(current.changes).toEqual([]);
  });

  it("keeps a taint that was already up when the child starts clean, and never lowers one", () => {
    const { service } = current;
    service.markTainted("u1", "s1");
    service.setChildPolicy("u1", "s1", { ...CHILD, taintedAt: null });
    expect(service.sessionPolicy("u1", "s1").taint.tainted).toBe(true);
  });

  it("refuses another owner's session and leaves that owner's row alone", () => {
    expect(() => current.service.setChildPolicy("u2", "s1", CHILD)).toThrow(new PapError("not_found"));
    current.service.setChildPolicy("u1", "s1", CHILD);
    expect(() => current.service.setChildPolicy("u2", "s1", { ...CHILD, mode: "read-only" })).toThrow(
      new PapError("not_found"),
    );
    expect(current.service.sessionPolicy("u1", "s1").mode).toBe("auto-accept-edits");
  });

  it("is an upsert scoped to the owner: a second write replaces mode and list for the same owner", () => {
    const { service } = current;
    service.setChildPolicy("u1", "s1", CHILD);
    service.setChildPolicy("u1", "s1", { mode: "read-only", tools: ["read"], taintedAt: null });
    expect(service.sessionPolicy("u1", "s1")).toMatchObject({
      mode: "read-only",
      toolAllowlist: ["read"],
      unattended: false,
      taint: { tainted: true },
    });
  });

  it("never rewrites a row of another owner, even when the store is called straight (the upsert's owner guard)", () => {
    const store = createSessionPolicyStore(current.db);
    store.setChild("u1", "s1", CHILD, 1);
    store.setChild("u2", "s1", { mode: "read-only", tools: null, taintedAt: null }, 2);
    expect(store.get("u1", "s1")).toMatchObject({
      approvalMode: "auto-accept-edits",
      toolAllowlist: ["read", "grep"],
      unattended: false,
    });
    expect(store.get("u2", "s1")).toBeUndefined();
  });
});
