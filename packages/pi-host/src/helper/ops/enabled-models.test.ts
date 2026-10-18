import { describe, expect, it } from "vitest";
import {
  CATALOG,
  COLLIDING,
  enabledKeys,
  models,
  off,
  on,
  providerOff,
  providerOn,
  type Row,
  runRows,
  SINGLE,
} from "../../testing/enabled-plans.ts";
import { type CatalogFacts, type EnabledPlan, PlanMismatch, planEnabledEdit } from "./enabled-models.ts";

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
];

describe("planEnabledEdit: table", () => {
  it("has at least 20 rows", () => expect(ROWS.length).toBeGreaterThanOrEqual(20));
  runRows(ROWS);
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
