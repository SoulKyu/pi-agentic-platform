import { GITHUB_BROWSER_ONLY, PapError, type Caller } from "@pap/contracts";

/** A token caller on a browser-only method is `forbidden` (S1 carry); B2 to B4 call this first in their services. */
export function assertBrowserCaller(method: string, caller: Pick<Caller, "kind">): void {
  if (caller.kind === "token" && GITHUB_BROWSER_ONLY.has(method)) throw new PapError("forbidden");
}
