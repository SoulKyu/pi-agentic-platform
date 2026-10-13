import { ALL_PERMISSIONS, type Caller } from "@pap/contracts";

/** A test's caller (agreement 7): the owner `u1` with every permission, on a browser session that has not confirmed its password. */
export const testCaller = (overrides: Partial<Caller> = {}): Caller => ({
  userId: "u1",
  permissions: new Set(ALL_PERMISSIONS),
  kind: "session",
  credentialId: "test-device",
  stepUpUntil: 0,
  ...overrides,
});
