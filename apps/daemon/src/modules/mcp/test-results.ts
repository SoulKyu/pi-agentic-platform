import type { McpTestResult, McpTestState } from "@pap/contracts";

/** At most this many servers keep a last result per owner (M7R97). */
export const TEST_RESULTS_MAX_PER_OWNER = 400;

type Scope = "global" | "project";

/** What the overview needs of a Test: not the tool names (up to 200 names each would weigh megabytes at the cap). */
export interface KeptTest {
  readonly at: number;
  readonly state: McpTestState;
  readonly count: number;
  readonly truncated: boolean;
}

/**
 * The last Test of each server, per owner, in this process only. A project server is kept per project folder (two projects
 * may name a server alike). A result for a name beyond the cap is not kept; the caller still gets it. `epoch` moves with
 * every `drop`: a Test that began before a removal passes its starting epoch to `put` and is not kept.
 */
export function createTestResults() {
  const byOwner = new Map<string, Map<string, KeptTest>>();
  let epoch = 0;
  const keyOf = (scope: Scope, name: string, cwd: string | undefined): string =>
    JSON.stringify([scope, name, scope === "project" ? (cwd ?? "") : ""]);

  return {
    epoch: (): number => epoch,
    /** False when the result was not kept: the owner is at the cap and the name is new, or an entry was removed since `since`. */
    put(
      owner: string,
      scope: Scope,
      name: string,
      cwd: string | undefined,
      result: McpTestResult,
      since?: number,
    ): boolean {
      if (since !== undefined && since !== epoch) return false;
      let kept = byOwner.get(owner);
      if (kept === undefined) {
        kept = new Map();
        byOwner.set(owner, kept);
      }
      const key = keyOf(scope, name, cwd);
      if (!kept.has(key) && kept.size >= TEST_RESULTS_MAX_PER_OWNER) return false;
      kept.set(key, {
        at: result.at,
        state: result.state,
        count: result.tools.length,
        truncated: result.toolsTruncated,
      });
      return true;
    },
    get: (owner: string, scope: Scope, name: string, cwd: string | undefined) =>
      byOwner.get(owner)?.get(keyOf(scope, name, cwd)),
    drop(owner: string, scope: Scope, name: string, cwd: string | undefined): void {
      epoch += 1;
      byOwner.get(owner)?.delete(keyOf(scope, name, cwd));
    },
  };
}
