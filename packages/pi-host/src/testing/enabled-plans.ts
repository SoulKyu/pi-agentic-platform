import { resolveModelScopeWithDiagnostics, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { type CatalogFacts, type EnabledOp, planEnabledEdit } from "../helper/ops/enabled-models.ts";

// The planner's table tests (`helper/ops/enabled-models*.test.ts`): catalogs, ops and the row runner they share.

export const models = (provider: string, ids: readonly string[]) =>
  ids.map((id) => ({ provider, id, name: id }));

/** Flat ids, a nested-id provider (OpenRouter style) and a provider mixing both. */
export const CATALOG: CatalogFacts = {
  models: [
    ...models("anthropic", ["claude-a", "claude-b"]),
    ...models("openai", ["gpt-1", "gpt-2", "gpt-3"]),
    ...models("p", ["m1", "m2", "m3"]),
    ...models("solo", ["only"]),
    ...models("openrouter", ["meta/llama", "meta/mistral"]),
    ...models("mixed", ["x", "a/b"]),
  ],
};
/** An aggregator whose model id repeats another provider's reference: `anthropic/*` reaches it by id. */
export const COLLIDING: CatalogFacts = {
  models: [...models("anthropic", ["claude-a", "claude-b"]), ...models("agg", ["anthropic/claude-a"])],
};
export const SINGLE: CatalogFacts = { models: models("solo", ["only"]) };

export const keyOf = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
/** Pi's own answer to "which models do these patterns enable?" (empty scope: every model). */
export async function enabledKeys(patterns: readonly string[] | undefined, catalog: CatalogFacts) {
  const all = catalog.models.map(keyOf);
  if (!patterns || patterns.length === 0) return new Set(all);
  const view = { getAvailable: async () => catalog.models } as unknown as ModelRuntime;
  const { scopedModels } = await resolveModelScopeWithDiagnostics([...patterns], view);
  return scopedModels.length === 0 ? new Set(all) : new Set(scopedModels.map(({ model }) => keyOf(model)));
}

export const off = (provider: string, modelId: string): EnabledOp => ({
  op: "toggle",
  provider,
  modelId,
  enabled: false,
});
export const on = (provider: string, modelId: string): EnabledOp => ({
  op: "toggle",
  provider,
  modelId,
  enabled: true,
});
export const providerOn = (provider: string): EnabledOp => ({ op: "provider", provider, enabled: true });
export const providerOff = (provider: string): EnabledOp => ({ op: "provider", provider, enabled: false });

export interface Row {
  readonly name: string;
  readonly patterns: readonly string[] | undefined;
  readonly op: EnabledOp;
  readonly expected: string[] | undefined | "last-model" | "too-large";
  readonly catalog?: CatalogFacts;
}

/** One test per row: the plan, then Pi's own resolution of the result against the row's intent. */
export function runRows(rows: readonly Row[]): void {
  for (const row of rows) {
    it(row.name, async () => {
      const catalog = row.catalog ?? CATALOG;
      const plan = await planEnabledEdit(row.patterns, row.op, catalog);
      if (row.expected === "last-model" || row.expected === "too-large") {
        expect(plan).toEqual({ refused: row.expected });
        return;
      }
      expect(plan).toEqual({ patterns: row.expected });
      const after = (plan as { patterns: string[] | undefined }).patterns;
      const before = await enabledKeys(row.patterns, catalog);
      const now = await enabledKeys(after, catalog);
      const expectedSet = new Set(before);
      if (row.op.op === "toggle") {
        if (row.op.enabled) expectedSet.add(`${row.op.provider}/${row.op.modelId}`);
        else expectedSet.delete(`${row.op.provider}/${row.op.modelId}`);
      } else if (row.op.op === "provider") {
        for (const model of catalog.models.filter(
          (m) => m.provider === (row.op as { provider: string }).provider,
        )) {
          if ((row.op as { enabled: boolean }).enabled) expectedSet.add(keyOf(model));
          else expectedSet.delete(keyOf(model));
        }
      } else if (row.op.op === "resync") {
        for (const model of catalog.models.filter((m) =>
          (row.op as { providers: string[] }).providers.includes(m.provider),
        ))
          expectedSet.add(keyOf(model));
      } else if (row.op.op === "clear") {
        for (const model of catalog.models) expectedSet.add(keyOf(model));
      }
      expect([...now].sort()).toEqual([...expectedSet].sort());
    });
  }
}
