import type { SettingsMembers } from "../index.ts";

/** The settings of a pap where nobody is capped (the owner alone). */
export const noCap: SettingsMembers = { capOf: () => null, ownerId: () => null, disabled: () => false };
