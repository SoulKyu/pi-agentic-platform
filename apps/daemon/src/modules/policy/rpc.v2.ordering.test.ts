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
const sessionPolicyBed = () => bedOf(make);

let current: ReturnType<typeof sessionPolicyBed>;
beforeEach(() => {
  current = sessionPolicyBed();
});
afterEach(() => current.dispose());
const bed = () => current;

describe("policy v2 mutations change their state before their first await (M5R9)", () => {
  it("stores the mode and tells the listener, and audits, before the promise is awaited", async () => {
    const { rpc, service, changes, audits, ctxOf } = bed();
    const pending = rpc["policy.setSessionMode"]({ sessionId: "s1", mode: "read-only" }, ctxOf("u1"));
    expect(service.sessionPolicy("u1", "s1")).toMatchObject({ mode: "read-only", explicit: true });
    expect(changes).toEqual(["u1:s1"]);
    expect(audits.map((line) => line.reason)).toEqual(["mode_changed"]);
    await pending;
  });

  it("clears the taint and tells the listener, and audits, before the promise is awaited", async () => {
    const { rpc, service, changes, audits, ctxOf } = bed();
    service.markTainted("u1", "s1");
    const pending = rpc["policy.clearTaint"]({ sessionId: "s1" }, ctxOf("u1"));
    expect(service.sessionPolicy("u1", "s1").taint).toEqual({ tainted: false, epoch: 1 });
    expect(changes).toEqual(["u1:s1", "u1:s1"]);
    expect(audits.map((line) => line.reason)).toEqual(["taint_cleared"]);
    await pending;
  });

  it("stores the settings and tells the listener, and audits, before the promise is awaited", async () => {
    const { rpc, service, settingsChanges, audits, ctxOf } = bed();
    const pending = rpc["policy.setSettings"](
      { value: { defaultMode: "supervised" } as never, baseRevision: 0 },
      ctxOf("u1"),
    );
    expect(service.settings("u1").defaultMode).toBe("supervised");
    expect(settingsChanges).toEqual(["u1"]);
    expect(audits.map((line) => line.reason)).toEqual(["settings_changed"]);
    await pending;
  });
});
