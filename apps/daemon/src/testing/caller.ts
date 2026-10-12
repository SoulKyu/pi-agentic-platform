import { ALL_PERMISSIONS, type Caller } from "@pap/contracts";

/** A caller for daemon tests (agreement 7): the bed's owner with every permission, then what the test overrides. */
export const testCaller = (overrides: Partial<Caller> = {}): Caller => ({
  userId: "u1",
  permissions: new Set(ALL_PERMISSIONS),
  ...overrides,
});
