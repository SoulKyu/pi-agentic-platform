import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import {
  createPasskeyBed,
  CRED_A,
  CRED_B,
  CRED_OTHER,
  OTHER_ID,
  OWNER_ID,
  shortId,
  T0,
  T1,
  T2,
} from "./testing/passkey-bed.ts";

let current: ReturnType<typeof createPasskeyBed> | undefined;
afterEach(() => {
  current?.dispose();
  current = undefined;
});
const bed = () => (current = createPasskeyBed());

describe("passkey management", () => {
  it("lists the owner's passkeys by a short hash of their id, with their last use", () => {
    const { manager, owner } = bed();
    expect(manager.list(owner)).toEqual([
      { id: shortId(CRED_B), createdAt: T1, lastUsedAt: T2, transports: ["usb", "nfc"] },
      { id: shortId(CRED_A), createdAt: T0, lastUsedAt: null, transports: ["internal"] },
    ]);
    expect(JSON.stringify(manager.list(owner))).not.toContain(CRED_A);
  });

  it("removes a passkey only after a step-up, and never another user's", () => {
    const { manager, owner, confirmed, rows } = bed();
    expect(() => manager.remove(owner, shortId(CRED_A))).toThrow(new PapError("step_up_required"));
    expect(rows()).toEqual([CRED_A, CRED_B, CRED_OTHER]);
    manager.remove(confirmed(), shortId(CRED_A));
    expect(rows()).toEqual([CRED_B, CRED_OTHER]);
    expect(() => manager.remove(confirmed(), shortId(CRED_OTHER))).toThrow(new PapError("not_found"));
    expect(() => manager.remove(confirmed(), shortId("never-enrolled"))).toThrow(new PapError("not_found"));
    expect(rows()).toEqual([CRED_B, CRED_OTHER]);
  });

  it("answers a stale step-up, a token and a caller without auth:admin without touching anything", () => {
    const { manager, clock, rows } = bed();
    const stale = testCaller({ userId: OWNER_ID, stepUpUntil: clock.now() });
    expect(() => manager.remove(stale, shortId(CRED_A))).toThrow(new PapError("step_up_required"));
    const live = clock.now() + 1000;
    const token = testCaller({ userId: OWNER_ID, kind: "token", stepUpUntil: live });
    const noAdmin = testCaller({ userId: OWNER_ID, permissions: new Set(["auth:read"]), stepUpUntil: live });
    for (const caller of [token, noAdmin]) {
      expect(() => manager.remove(caller, shortId(CRED_A))).toThrow(new PapError("forbidden"));
    }
    expect(() => manager.list(testCaller({ permissions: new Set() }))).toThrow(new PapError("forbidden"));
    expect(rows()).toEqual([CRED_A, CRED_B, CRED_OTHER]);
  });

  it("signs out the browsers the removed passkey opened, and only those (M5R76, MQ8)", () => {
    const { manager, confirmed, sessionsOf, startSession, stepUps, db } = bed();
    const byA = startSession({ method: "passkey", passkeyRef: shortId(CRED_A) });
    const byB = startSession({ method: "passkey", passkeyRef: shortId(CRED_B) });
    const byPassword = startSession({ method: "password" });
    stepUps.mark(byA.idHash);
    stepUps.mark(byB.idHash);
    expect(manager.remove(confirmed(), shortId(CRED_A))).toEqual({ revoked: 1 });
    expect(sessionsOf(OWNER_ID)).toEqual(expect.arrayContaining([byB.publicId, byPassword.publicId]));
    expect(sessionsOf(OWNER_ID)).not.toContain(byA.publicId);
    expect(sessionsOf(OWNER_ID)).toHaveLength(2);
    expect(stepUps.until(byA.idHash)).toBe(0);
    expect(stepUps.until(byB.idHash)).not.toBe(0);
    expect(db.get("SELECT 1 AS x FROM auth_sessions WHERE id_hash = $h", { h: byA.idHash })).toBe(undefined);
  });

  it("lets the last passkey go: the password stays the way back in", () => {
    const { manager, confirmed, rows, db } = bed();
    db.run("DELETE FROM passkeys WHERE id = $id", { id: CRED_A });
    expect(manager.remove(confirmed(), shortId(CRED_B))).toEqual({ revoked: 0 });
    expect(rows()).toEqual([CRED_OTHER]);
    expect(manager.list(confirmed())).toEqual([]);
  });

  it("does not sign out another user's browsers that share nothing with the passkey", () => {
    const { manager, confirmed, service, sessionsOf } = bed();
    service.startSession(OTHER_ID, undefined, {
      ip: "10.0.0.2",
      method: "passkey",
      passkeyRef: shortId(CRED_OTHER),
    });
    manager.remove(confirmed(), shortId(CRED_A));
    expect(sessionsOf(OTHER_ID)).toHaveLength(1);
  });

  it("counts only live sessions and audits the removal with the count and nothing secret", () => {
    const { manager, confirmed, clock, startSession, audited, db } = bed();
    startSession({ method: "passkey", passkeyRef: shortId(CRED_A) });
    const expired = startSession({ method: "passkey", passkeyRef: shortId(CRED_A) });
    db.run("UPDATE auth_sessions SET expires_at = $at WHERE id_hash = $h", {
      at: clock.now(),
      h: expired.idHash,
    });
    expect(manager.remove(confirmed(), shortId(CRED_A))).toEqual({ revoked: 1 });
    expect(db.all("SELECT 1 FROM auth_sessions WHERE passkey_ref = $ref", { ref: shortId(CRED_A) })).toEqual(
      [],
    );
    expect(audited).toEqual([
      {
        ownerId: OWNER_ID,
        actor: "user",
        kind: "auth",
        reason: "passkey_removed",
        detail: { passkeyId: shortId(CRED_A), count: 1 },
      },
    ]);
    expect(JSON.stringify(audited)).not.toContain(CRED_A);
  });

  it("audits nothing when the removal is refused", () => {
    const { manager, owner, audited } = bed();
    expect(() => manager.remove(owner, shortId(CRED_A))).toThrow(PapError);
    expect(audited).toEqual([]);
  });
});
