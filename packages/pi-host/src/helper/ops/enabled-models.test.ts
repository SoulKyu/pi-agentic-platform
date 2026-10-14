import { resolveModelScopeWithDiagnostics, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  type CatalogFacts,
  type EnabledOp,
  type EnabledPlan,
  PlanMismatch,
  planEnabledEdit,
} from "./enabled-models.ts";

const models = (provider: string, ids: readonly string[]) => ids.map((id) => ({ provider, id, name: id }));

/** Flat ids, a nested-id provider (OpenRouter style) and a provider mixing both. */
const CATALOG: CatalogFacts = {
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
const COLLIDING: CatalogFacts = {
  models: [...models("anthropic", ["claude-a", "claude-b"]), ...models("agg", ["anthropic/claude-a"])],
};
const SINGLE: CatalogFacts = { models: models("solo", ["only"]) };

const keyOf = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
/** Pi's own answer to "which models do these patterns enable?" (empty scope: every model). */
async function enabledKeys(patterns: readonly string[] | undefined, catalog: CatalogFacts) {
  const all = catalog.models.map(keyOf);
  if (!patterns || patterns.length === 0) return new Set(all);
  const view = { getAvailable: async () => catalog.models } as unknown as ModelRuntime;
  const { scopedModels } = await resolveModelScopeWithDiagnostics([...patterns], view);
  return scopedModels.length === 0 ? new Set(all) : new Set(scopedModels.map(({ model }) => keyOf(model)));
}

const off = (provider: string, modelId: string): EnabledOp => ({
  op: "toggle",
  provider,
  modelId,
  enabled: false,
});
const on = (provider: string, modelId: string): EnabledOp => ({
  op: "toggle",
  provider,
  modelId,
  enabled: true,
});
const providerOn = (provider: string): EnabledOp => ({ op: "provider", provider, enabled: true });
const providerOff = (provider: string): EnabledOp => ({ op: "provider", provider, enabled: false });

interface Row {
  readonly name: string;
  readonly patterns: readonly string[] | undefined;
  readonly op: EnabledOp;
  readonly expected: string[] | undefined | "last-model" | "too-large";
  readonly catalog?: CatalogFacts;
}

const ROWS: readonly Row[] = [
  {
    name: "off in a provider glob expands it in place",
    patterns: ["anthropic/*"],
    op: off("anthropic", "claude-a"),
    expected: ["anthropic/claude-b"],
  },
  {
    name: "off keeps the glob's thinking level",
    patterns: ["anthropic/*:high"],
    op: off("anthropic", "claude-a"),
    expected: ["anthropic/claude-b:high"],
  },
  {
    name: "an unmatched pattern stays verbatim on a switch",
    patterns: ["foo/*", "unknown-x", "anthropic/*"],
    op: off("anthropic", "claude-a"),
    expected: ["foo/*", "unknown-x", "anthropic/claude-b"],
  },
  {
    name: "on appends one exact entry and keeps the unmatched ones",
    patterns: ["foo/*", "unknown-x", "anthropic/claude-a"],
    op: on("openai", "gpt-1"),
    expected: ["foo/*", "unknown-x", "anthropic/claude-a", "openai/gpt-1"],
  },
  {
    name: "on for a model a glob already covers changes nothing",
    patterns: ["p/*"],
    op: on("p", "m1"),
    expected: ["p/*"],
  },
  {
    name: "on that completes a provider collapses its entries to a glob",
    patterns: ["p/m1", "p/m2"],
    op: on("p", "m3"),
    expected: ["p/*"],
  },
  {
    name: "on beside a lone exact entry keeps both",
    patterns: ["p/m1"],
    op: on("anthropic", "claude-a"),
    expected: ["p/m1", "anthropic/claude-a"],
  },
  {
    name: "on with every model already enabled changes nothing",
    patterns: undefined,
    op: on("p", "m1"),
    expected: undefined,
  },
  { name: "off drops an exact entry", patterns: ["p/m1", "p/m2"], op: off("p", "m1"), expected: ["p/m2"] },
  {
    name: "off in an exact entry keeps the others' levels",
    patterns: ["p/m1:low", "p/m2:high"],
    op: off("p", "m1"),
    expected: ["p/m2:high"],
  },
  {
    name: "off expands a leveled glob model by model",
    patterns: ["p/*:low"],
    op: off("p", "m2"),
    expected: ["p/m1:low", "p/m3:low"],
  },
  {
    name: "off through an id-only glob names the survivors with their provider",
    patterns: ["gpt-*"],
    op: off("openai", "gpt-2"),
    expected: ["openai/gpt-1", "openai/gpt-3"],
  },
  {
    name: "off a model that a bare id names, beside another entry",
    patterns: ["claude-a", "p/m1"],
    op: off("anthropic", "claude-a"),
    expected: ["p/m1"],
  },
  {
    name: "off a model nothing enables changes nothing",
    patterns: ["p/m1"],
    op: off("p", "m2"),
    expected: ["p/m1"],
  },
  {
    name: "off the last enabled model is refused",
    patterns: ["solo/only"],
    op: off("solo", "only"),
    expected: "last-model",
  },
  {
    name: "off the last model of a glob-only scope is refused",
    patterns: ["claude-a"],
    op: off("anthropic", "claude-a"),
    expected: "last-model",
  },
  {
    name: "off the only model of the catalog is refused",
    patterns: undefined,
    op: off("solo", "only"),
    expected: "last-model",
    catalog: SINGLE,
  },
  {
    name: "off from every-model writes one glob per untouched provider and exact entries for the rest",
    patterns: undefined,
    op: off("anthropic", "claude-a"),
    expected: ["anthropic/claude-b", "openai/*", "p/*", "solo/only", "openrouter/**", "mixed/**"],
  },
  {
    name: "an empty list means every model, like no list",
    patterns: [],
    op: off("anthropic", "claude-a"),
    expected: ["anthropic/claude-b", "openai/*", "p/*", "solo/only", "openrouter/**", "mixed/**"],
  },
  {
    name: "off from a list that matches nothing keeps its entries and lists the rest",
    patterns: ["foo/*"],
    op: off("solo", "only"),
    expected: ["foo/*", "anthropic/*", "openai/*", "p/*", "openrouter/**", "mixed/**"],
  },
  {
    name: "provider on collapses three exact entries to a glob that matches exactly",
    patterns: ["p/m1", "p/m2", "p/m3"],
    op: providerOn("p"),
    expected: ["p/*"],
  },
  {
    name: "provider on completes a partial provider and collapses it where its first entry was",
    patterns: ["anthropic/claude-a", "p/m1", "p/m2"],
    op: providerOn("p"),
    expected: ["anthropic/claude-a", "p/*"],
  },
  {
    name: "provider on with nested ids collapses to the double-star glob, never the single star",
    patterns: ["openrouter/meta/llama"],
    op: providerOn("openrouter"),
    expected: ["openrouter/**"],
  },
  {
    name: "provider on with flat and nested ids collapses to the double-star glob",
    patterns: ["mixed/x"],
    op: providerOn("mixed"),
    expected: ["mixed/**"],
  },
  {
    name: "provider on writes model by model when no glob matches exactly",
    patterns: ["anthropic/claude-a"],
    op: providerOn("anthropic"),
    expected: ["anthropic/claude-a", "anthropic/claude-b"],
    catalog: COLLIDING,
  },
  {
    name: "provider on keeps a leveled entry and adds the rest without collapsing",
    patterns: ["p/m1:low", "p/m2"],
    op: providerOn("p"),
    expected: ["p/m1:low", "p/m2", "p/m3"],
  },
  {
    name: "provider on for a provider already fully enabled by one entry changes nothing",
    patterns: ["p/*", "anthropic/claude-a"],
    op: providerOn("p"),
    expected: ["p/*", "anthropic/claude-a"],
  },
  {
    name: "provider on with every model enabled changes nothing",
    patterns: undefined,
    op: providerOn("p"),
    expected: undefined,
  },
  {
    name: "provider off leaves the other providers' entries alone",
    patterns: ["anthropic/*", "openai/*"],
    op: providerOff("openai"),
    expected: ["anthropic/*"],
  },
  {
    name: "provider off expands a cross-provider glob without that provider",
    patterns: ["*1", "anthropic/claude-a"],
    op: providerOff("openai"),
    expected: ["p/m1", "anthropic/claude-a"],
  },
  {
    name: "provider off of the only enabled provider is refused",
    patterns: ["openai/*"],
    op: providerOff("openai"),
    expected: "last-model",
  },
  {
    name: "provider off from every-model lists the other providers",
    patterns: undefined,
    op: providerOff("openrouter"),
    expected: ["anthropic/*", "openai/*", "p/*", "solo/only", "mixed/**"],
  },
  {
    name: "prune drops only the unmatched entries",
    patterns: ["foo/*", "anthropic/claude-a", "unknown-x", "p/*:low"],
    op: { op: "prune" },
    expected: ["anthropic/claude-a", "p/*:low"],
  },
  {
    name: "prune with nothing to drop changes nothing",
    patterns: ["anthropic/*", "p/m1"],
    op: { op: "prune" },
    expected: ["anthropic/*", "p/m1"],
  },
  {
    name: "prune of a list that matches nothing clears the key",
    patterns: ["foo/*", "unknown-x"],
    op: { op: "prune" },
    expected: undefined,
  },
  { name: "clear removes the key", patterns: ["anthropic/*"], op: { op: "clear" }, expected: undefined },
  {
    name: "resync re-asserts a provider that was fully enabled and left every other entry alone",
    patterns: ["x/old", "p/m1", "p/m2"],
    op: { op: "resync", providers: ["p"] },
    expected: ["x/old", "p/*"],
  },
  {
    name: "resync with no provider changes nothing",
    patterns: ["x/old", "p/m1"],
    op: { op: "resync", providers: [] },
    expected: ["x/old", "p/m1"],
  },
  {
    name: "resync with every model enabled changes nothing",
    patterns: undefined,
    op: { op: "resync", providers: ["p"] },
    expected: undefined,
  },
  {
    name: "a list that would need more entries than the contract allows is refused",
    patterns: ["big/*"],
    op: off("big", "m0"),
    expected: "too-large",
    catalog: {
      models: models(
        "big",
        Array.from({ length: 300 }, (_, i) => `m${i}`),
      ),
    },
  },
];

describe("planEnabledEdit: table", () => {
  it("has at least 20 rows", () => expect(ROWS.length).toBeGreaterThanOrEqual(20));

  for (const row of ROWS) {
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
});

describe("planEnabledEdit: Pi's own resolution decides", () => {
  it("never reaches another provider's model through an id that repeats the glob", async () => {
    // `anthropic/*` also reaches the aggregator's model `anthropic/claude-a` by its id: switching claude-a off keeps
    // that model enabled, named in full.
    const plan = (await planEnabledEdit(
      ["anthropic/*"],
      off("anthropic", "claude-a"),
      COLLIDING,
    )) as EnabledPlan & {
      patterns: string[];
    };
    expect(plan.patterns).toEqual(["anthropic/claude-b", "agg/anthropic/claude-a"]);
    expect([...(await enabledKeys(plan.patterns, COLLIDING))].sort()).toEqual([
      "agg/anthropic/claude-a",
      "anthropic/claude-b",
    ]);
  });

  it("does not mutate the list it was given", async () => {
    const current = ["anthropic/*"];
    await planEnabledEdit(current, off("anthropic", "claude-a"), CATALOG);
    expect(current).toEqual(["anthropic/*"]);
  });

  it("refuses to write a list Pi would read differently (case-twin ids resolve to one model)", async () => {
    const twins: CatalogFacts = { models: [...models("p", ["Foo", "foo"]), ...models("q", ["z"])] };
    const results = await Promise.allSettled([
      planEnabledEdit(undefined, off("p", "foo"), twins),
      planEnabledEdit(undefined, off("p", "Foo"), twins),
    ]);
    expect(results.some((result) => result.status === "rejected")).toBe(true);
    for (const result of results)
      if (result.status === "rejected") expect(result.reason).toBeInstanceOf(PlanMismatch);
  });

  it("leaves a model it cannot find alone", async () => {
    expect(await planEnabledEdit(["p/m1"], on("nobody", "nothing"), CATALOG)).toEqual({ patterns: ["p/m1"] });
    expect(await planEnabledEdit(["p/m1"], providerOn("nobody"), CATALOG)).toEqual({ patterns: ["p/m1"] });
  });
});
