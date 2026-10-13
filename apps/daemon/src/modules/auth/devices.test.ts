import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { createDeviceBed, OWNER_ID } from "./testing/device-bed.ts";

let current: ReturnType<typeof createDeviceBed> | undefined;
afterEach(() => {
  current?.dispose();
  current = undefined;
});
const bed = () => (current = createDeviceBed());

describe("connected devices", () => {
  it("lists the owner's devices with this one marked, newest first, never another user's", () => {
    const { devices, current } = bed();
    const listed = devices.list(current);
    expect(listed.map((d) => [d.current, d.method])).toEqual([
      [true, "passkey"],
      [false, "password"],
      [false, "setup"],
    ]);
    expect(listed.every((d) => /^[0-9a-f]{32}$/.test(d.id))).toBe(true);
    expect(JSON.stringify(listed)).not.toMatch(/idHash|id_hash|cookie|passkeyRef|p{32}/);
    expect(listed[0]).toMatchObject({ browser: "other", os: "other", ip: "10.0.0.1" });
  });

  it("revokes one device, signs out the others, and refuses another owner's id", () => {
    const { devices, current, other, sessionsOf } = bed();
    const [, second] = devices.list(current);
    devices.revoke(current, second?.id ?? "");
    expect(sessionsOf(OWNER_ID)).toHaveLength(2);
    expect(() => devices.revoke(current, other.deviceId)).toThrow(new PapError("not_found"));
    expect(() => devices.revoke(current, "f".repeat(32))).toThrow(new PapError("not_found"));
    expect(devices.revokeOthers(current)).toEqual({ revoked: 1 });
    expect(sessionsOf(OWNER_ID)).toEqual([current.credentialId]);
    expect(sessionsOf("other-1")).toHaveLength(1);
  });

  it("revokes this browser too when asked: that is signing out", () => {
    const { devices, current, sessionsOf } = bed();
    devices.revoke(current, current.credentialId);
    expect(sessionsOf(OWNER_ID)).toHaveLength(2);
  });

  it("audits both mutations with the id or the count, and nothing secret", () => {
    const { devices, current, audited, publicIds, cookies } = bed();
    devices.revoke(current, publicIds.second);
    devices.revokeOthers(current);
    expect(audited).toEqual([
      {
        ownerId: OWNER_ID,
        actor: "user",
        kind: "auth",
        reason: "device_revoked",
        detail: { deviceId: publicIds.second },
      },
      { ownerId: OWNER_ID, actor: "user", kind: "auth", reason: "devices_revoked", detail: { count: 1 } },
    ]);
    expect(JSON.stringify(audited)).not.toContain(cookies.second);
  });

  it("answers a caller without the permission or without a browser session with forbidden, touching nothing", () => {
    const { devices, current, sessionsOf, publicIds } = bed();
    const forbidden = new PapError("forbidden");
    const noAdmin = testCaller({ ...current, permissions: new Set(["auth:read"]) });
    expect(() => devices.revoke(noAdmin, publicIds.second)).toThrow(forbidden);
    expect(() => devices.revokeOthers(noAdmin)).toThrow(forbidden);
    expect(() => devices.list(testCaller({ ...current, permissions: new Set() }))).toThrow(forbidden);
    const token = testCaller({ ...current, kind: "token", credentialId: "tok-1" });
    expect(() => devices.revokeOthers(token)).toThrow(forbidden);
    expect(() => devices.revoke(token, publicIds.second)).toThrow(forbidden);
    expect(sessionsOf(OWNER_ID)).toHaveLength(3);
  });

  it("drops expired rows first and shows at most 200", () => {
    const { devices, current, db, clock, store } = bed();
    for (let i = 0; i < 205; i++) {
      store.insertSession({
        idHash: `${i}`.padStart(64, "0"),
        publicId: `${i}`.padStart(32, "e"),
        userId: OWNER_ID,
        createdAt: clock.now() - 1000 - i,
        lastSeenAt: clock.now(),
        expiresAt: clock.now() + 1000,
        userAgent: null,
        ip: null,
        method: null,
        passkeyRef: null,
      });
    }
    db.run("UPDATE auth_sessions SET expires_at = 1 WHERE public_id = $id", {
      id: `${0}`.padStart(32, "e"),
    });
    const listed = devices.list(current);
    expect(listed).toHaveLength(200);
    expect(listed[0]?.current).toBe(true);
    expect(
      db.get("SELECT 1 AS x FROM auth_sessions WHERE public_id = $id", { id: "0".padStart(32, "e") }),
    ).toBe(undefined);
  });

  it("ignores expired rows: revoking an expired id answers like an unknown one, and the others count live rows only", () => {
    const { devices, current, db, clock, publicIds } = bed();
    db.run("UPDATE auth_sessions SET expires_at = $at WHERE public_id = $id", {
      at: clock.now(),
      id: publicIds.second,
    });
    expect(() => devices.revoke(current, publicIds.second)).toThrow(new PapError("not_found"));
    expect(devices.revokeOthers(current)).toEqual({ revoked: 1 });
  });
});
