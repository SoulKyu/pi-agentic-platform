import { DEFAULT_POLICY_SETTINGS, type LocalToolRule, PolicySettings } from "@pap/contracts";
import type { RpcClient } from "../../../runtime/rpc.ts";
import { failureCode } from "../failure.ts";

/** The distinct tool and source pairs (taint causes, the asked tool): what "Mark as local" stores (the exact registered source). */
export function rulesOf(items: readonly LocalToolRule[]): LocalToolRule[] {
  const seen = new Set<string>();
  const rules: LocalToolRule[] = [];
  for (const { tool, source } of items) {
    const id = `${tool}\n${source}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rules.push({ tool, source });
  }
  return rules;
}

/**
 * Decision 117, A3. Adds the missing rules to the owner's settings (read, then written with the revision read), then
 * clears this session's taint when the rules cover its every cause. A `conflict` re-reads and tries once more; a second
 * one is thrown. Nothing is written when every rule is already listed, so a retry after a failed clear never writes twice.
 */
export async function markLocal(
  rpc: RpcClient,
  sessionId: string,
  rules: readonly LocalToolRule[],
  clearTaint: boolean,
): Promise<void> {
  const wanted = rulesOf(rules);
  const write = async (): Promise<void> => {
    const stored = await rpc.call("policy.getSettings", {});
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
  if (clearTaint) await rpc.call("policy.clearTaint", { sessionId }, { commandId: rpc.newCommandId() });
}
