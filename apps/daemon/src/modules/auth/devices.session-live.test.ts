import { afterEach, describe, expect, it } from "vitest";
import { createDeviceBed, OTHER_ID, OWNER_ID } from "./testing/device-bed.ts";

let current: ReturnType<typeof createDeviceBed> | undefined;
afterEach(() => {
  current?.dispose();
  current = undefined;
});
const bed = () => (current = createDeviceBed());

describe("sessionLive (push: is the credential that created a subscription still signed in)", () => {
  it("is true for a live session of that owner", () => {
    const { store, publicIds, clock } = bed();
    expect(store.sessionLive(OWNER_ID, publicIds.current, clock.now())).toBe(true);
    expect(store.sessionLive(OWNER_ID, publicIds.third, clock.now())).toBe(true);
  });

  it("is false for another owner's session, an unknown id and a revoked session", () => {
    const { store, publicIds, clock, devices, current: caller, other } = bed();
    expect(store.sessionLive(OWNER_ID, other.deviceId, clock.now())).toBe(false);
    expect(store.sessionLive(OTHER_ID, publicIds.current, clock.now())).toBe(false);
    expect(store.sessionLive(OWNER_ID, "f".repeat(32), clock.now())).toBe(false);
    devices.revoke(caller, publicIds.second);
    expect(store.sessionLive(OWNER_ID, publicIds.second, clock.now())).toBe(false);
  });

  it("is false once the session has expired, and reads without deleting anything", async () => {
    const { store, publicIds, clock, sessionsOf } = bed();
    await clock.advance(31 * 24 * 3_600_000);
    expect(store.sessionLive(OWNER_ID, publicIds.current, clock.now())).toBe(false);
    expect(sessionsOf(OWNER_ID)).toHaveLength(3);
  });
});
