import type { ToolPreset } from "@pap/contracts";

/** The strict order of the clamp (W5-R28): `chat` is the narrowest. `configured` has no place in it. */
const ORDER: Readonly<Record<Exclude<ToolPreset, "configured">, number>> = {
  chat: 0,
  none: 1,
  "read-only": 2,
  default: 3,
  full: 4,
};

/**
 * The preset an agent thread runs with: the narrower of the owner's choice and the start-time profile's (W5-R28). The owner
 * can narrow and never widen past the profile. `configured` is Pi's own default tools and cannot be compared: an owner
 * choice of it on any other profile ranks as `full`, so it clamps to the profile; on a `configured` profile only
 * `configured`, `none` and `chat` are accepted, anything wider gives the profile's. (The step-up rank of M11R44 is separate.)
 */
export function narrowPreset(owner: ToolPreset, profile: ToolPreset): ToolPreset {
  if (profile === "configured") return owner === "configured" || ORDER[owner] <= ORDER.none ? owner : profile;
  if (owner === "configured") return profile;
  return ORDER[owner] <= ORDER[profile] ? owner : profile;
}
