import { scanFences } from "@pap/contracts";

/**
 * The body of the `fenceIndex`-th fence of a reply when its language is html (UX2-R33), else null. The daemon and the web scan
 * replies with the same `scanFences`, so they agree on every index.
 */
export function htmlFenceBody(text: string, fenceIndex: number): string | null {
  const fence = scanFences(text)[fenceIndex];
  return fence !== undefined && fence.lang === "html" ? fence.body : null;
}
