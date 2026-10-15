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
const sessionPolicyBed = () => bedOf(make);

let current: ReturnType<typeof sessionPolicyBed>;
beforeEach(() => {
  current = sessionPolicyBed();
});
afterEach(() => current.dispose());
const bed = () => current;

describe("session policy service", () => {
  it("follows the owner's default mode until the session has its own, and back on null", () => {
    const { service, changes } = bed();
    expect(service.sessionPolicy("u1", "s1")).toEqual({
      mode: "auto-accept-edits",
      explicit: false,
      taint: { tainted: false, epoch: 0 },
      toolAllowlist: null,
      unattended: false,
      recorded: false,
    });
    service.setSessionMode(testCaller(), "s1", "read-only");
    expect(service.sessionPolicy("u1", "s1")).toMatchObject({ mode: "read-only", explicit: true });
    service.setSessionMode(testCaller(), "s1", null);
    expect(service.sessionPolicy("u1", "s1")).toMatchObject({ mode: "auto-accept-edits", explicit: false });
    expect(changes).toEqual(["u1:s1", "u1:s1"]);
  });

  it("follows a changed owner default for a session without its own mode", () => {
    const { service } = bed();
    service.setSettings(testCaller(), { defaultMode: "supervised" }, 0);
    expect(service.sessionPolicy("u1", "s1")).toMatchObject({ mode: "supervised", explicit: false });
    service.setSessionMode(testCaller(), "s2", "full-access");
    expect(service.sessionPolicy("u1", "s2")).toMatchObject({ mode: "full-access", explicit: true });
  });

  it("refuses another owner's session and an unknown one alike", () => {
    const { service, audits, changes } = bed();
    expect(() => service.setSessionMode(testCaller({ userId: "u2" }), "s1", "full-access")).toThrow(
      new PapError("not_found"),
    );
    expect(() => service.clearTaint(testCaller(), "nope")).toThrow(new PapError("not_found"));
    expect(() => service.clearTaint(testCaller({ userId: "u2" }), "s1")).toThrow(new PapError("not_found"));
    expect(audits).toEqual([]);
    expect(changes).toEqual([]);
    expect(service.sessionPolicy("u1", "s1")).toMatchObject({ explicit: false });
  });

  it("reads another owner's session as the defaults, never its mode", () => {
    const { service } = bed();
    service.setSessionMode(testCaller(), "s1", "read-only");
    expect(service.sessionPolicy("u2", "s1")).toMatchObject({ mode: "auto-accept-edits", explicit: false });
  });

  it("raises the taint once, clears it with a new epoch, and copies it to a fork (M5R55)", () => {
    const { service, changes } = bed();
    expect(service.markTainted("u1", "s1")).toBe(true);
    expect(service.markTainted("u1", "s1")).toBe(false);
    service.inherit("u1", "s1", "s2");
    expect(service.sessionPolicy("u1", "s2").taint).toEqual({ tainted: true, epoch: 0 });
    service.clearTaint(testCaller(), "s1");
    expect(service.sessionPolicy("u1", "s1").taint).toEqual({ tainted: false, epoch: 1 });
    expect(changes).toEqual(["u1:s1", "u1:s1"]);
  });

  it("raises the taint again after a clear, keeping the epoch", () => {
    const { service } = bed();
    service.markTainted("u1", "s1");
    service.clearTaint(testCaller(), "s1");
    expect(service.markTainted("u1", "s1")).toBe(true);
    expect(service.sessionPolicy("u1", "s1").taint).toEqual({ tainted: true, epoch: 1 });
    service.clearTaint(testCaller(), "s1");
    expect(service.sessionPolicy("u1", "s1").taint).toEqual({ tainted: false, epoch: 2 });
  });

  it("copies the mode with the taint on a fork, at epoch 0 even when the source cleared before", () => {
    const { service } = bed();
    service.setSessionMode(testCaller(), "s1", "supervised");
    service.markTainted("u1", "s1");
    service.clearTaint(testCaller(), "s1");
    service.markTainted("u1", "s1");
    service.inherit("u1", "s1", "s2");
    expect(service.sessionPolicy("u1", "s2")).toEqual({
      mode: "supervised",
      explicit: true,
      taint: { tainted: true, epoch: 0 },
      toolAllowlist: null,
      unattended: false,
      recorded: true,
    });
  });

  it("refuses to taint or inherit across owners and unknown sessions", () => {
    const { service, addSession } = bed();
    addSession("s9", "u2");
    expect(() => service.markTainted("u1", "s9")).toThrow(new PapError("not_found"));
    expect(() => service.markTainted("u1", "nope")).toThrow(new PapError("not_found"));
    expect(() => service.inherit("u1", "s1", "s9")).toThrow(new PapError("not_found"));
    expect(() => service.inherit("u1", "s9", "s1")).toThrow(new PapError("not_found"));
    expect(service.sessionPolicy("u1", "s1").taint.tainted).toBe(false);
  });

  it("cascades a removed session's policy row away", () => {
    const { service, db } = bed();
    service.setSessionMode(testCaller(), "s1", "read-only");
    db.run("DELETE FROM sessions WHERE id = 's1'");
    expect(db.get("SELECT 1 FROM session_policy WHERE session_id = 's1'")).toBeUndefined();
  });

  it("audits each mutation with its facts and no more", () => {
    const { service, audits } = bed();
    service.setSessionMode(testCaller({ kind: "token", credentialId: "t1" }), "s1", "full-access");
    service.setSessionMode(testCaller(), "s1", null);
    service.clearTaint(testCaller(), "s1");
    expect(audits).toEqual([
      {
        ownerId: "u1",
        actor: "token",
        actorId: "t1",
        kind: "policy",
        reason: "mode_changed",
        sessionId: "s1",
        detail: { mode: "full-access" },
      },
      {
        ownerId: "u1",
        actor: "user",
        actorId: "test-device",
        kind: "policy",
        reason: "mode_changed",
        sessionId: "s1",
        detail: { mode: "default" },
      },
      {
        ownerId: "u1",
        actor: "user",
        actorId: "test-device",
        kind: "policy",
        reason: "taint_cleared",
        sessionId: "s1",
      },
    ]);
  });

  it("keeps going when a listener throws", () => {
    const { service, lines } = bed();
    service.onSessionChange(() => {
      throw new Error("gone");
    });
    service.setSessionMode(testCaller(), "s1", "read-only");
    expect(service.sessionPolicy("u1", "s1").mode).toBe("read-only");
    expect(lines.some((line) => line.msg === "policy_listener_failed")).toBe(true);
  });

  it("stops telling a listener once it is removed", () => {
    const { service } = bed();
    const seen: string[] = [];
    const off = service.onSessionChange((_owner, sessionId) => void seen.push(sessionId));
    service.setSessionMode(testCaller(), "s1", "read-only");
    off();
    service.setSessionMode(testCaller(), "s1", null);
    expect(seen).toEqual(["s1"]);
  });
});
