import { DEFAULT_POLICY_SETTINGS, type LocalToolRule, PolicySettings, type TaintCause } from "@pap/contracts";
import type { RpcClient } from "../../../runtime/rpc.ts";
import { failureCode } from "../failure.ts";

/** The distinct tool and source pairs of the causes: what "Mark as local" stores (the exact registered source). */
export function rulesOf(causes: readonly TaintCause[]): LocalToolRule[] {
  const seen = new Set<string>();
  const rules: LocalToolRule[] = [];
  for (const { tool, source } of causes) {
    const id = `${tool}\n${source}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rules.push({ tool, source });
  }
  return rules;
}

/**
 * Decision 117, A3. Adds the missing rules to the owner's settings (read, then written with the revision read), then
 * clears this session's taint. A `conflict` re-reads and tries once more; a second one is thrown. Nothing is written when
 * every rule is already listed, so a retry after a failed clear never writes twice.
 */
export async function markCausesLocal(
  rpc: RpcClient,
  sessionId: string,
  causes: readonly TaintCause[],
): Promise<void> {
  const wanted = rulesOf(causes);
  const write = async (): Promise<void> => {
    const stored = await rpc.call("policy.getSettings", {});
    // The wire type leaves the defaults optional: parsing fills them.
    const base = PolicySettings.parse(stored.value ?? DEFAULT_POLICY_SETTINGS);
    const missing = wanted.filter(
      (rule) => !base.localTools.some((have) => have.tool === rule.tool && have.source === rule.source),
    );
    if (missing.length === 0) return;
    await rpc.call(
      "policy.setSettings",
      { value: { ...base, localTools: [...base.localTools, ...missing] }, baseRevision: stored.revision },
      { commandId: rpc.newCommandId() },
    );
  };
  try {
    await write();
  } catch (failure) {
    if (failureCode(failure) !== "conflict") throw failure;
    await write();
  }
  await rpc.call("policy.clearTaint", { sessionId }, { commandId: rpc.newCommandId() });
}
