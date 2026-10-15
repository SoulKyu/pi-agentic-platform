import { randomBytes } from "node:crypto";
import { slugOf } from "@pap/contracts";

/** The branch `<prefix><slug>`, then `-2` to `-20`: after the twentieth that exists, the create is `limit_reached` (M9R32). */
export const BRANCH_TRIES = 20;

/** `slugOf(title)`, a dash and 4 random hex digits (M9R32). The slug is at most 40, so the id is at most 45 characters. */
export function laneIdOf(title: string, random: (bytes: number) => Buffer = randomBytes): string {
  return `${slugOf(title)}-${random(2).toString("hex")}`;
}

export function branchCandidates(prefix: string, slug: string): string[] {
  return Array.from({ length: BRANCH_TRIES }, (_, n) => `${prefix}${slug}${n === 0 ? "" : `-${n + 1}`}`);
}
