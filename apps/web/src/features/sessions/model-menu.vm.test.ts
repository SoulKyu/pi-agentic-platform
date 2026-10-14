import type { ModelSummary } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { groupModels } from "./model-menu.vm.ts";

const model = (provider: string, id: string, name = id): ModelSummary => ({
  provider,
  id,
  name,
  reasoning: true,
});
const LIST = [
  model("openai", "gpt-5"),
  model("anthropic", "claude-sonnet-4", "Claude Sonnet 4"),
  model("openai", "gpt-5-mini"),
  model("anthropic", "claude-opus-4", "Claude Opus 4"),
  model("zeta", "alpha-1"),
];
const NO_DEFAULTS = { provider: null, model: null };

describe("groupModels", () => {
  it("keeps the providers in the order the list shows them first, and each provider's models in list order", () => {
    const groups = groupModels(LIST, "", null, NO_DEFAULTS);
    expect(groups.map((group) => group.provider)).toEqual(["openai", "anthropic", "zeta"]);
    expect(groups[0]?.rows.map((row) => row.model.id)).toEqual(["gpt-5", "gpt-5-mini"]);
    expect(groups[1]?.rows.map((row) => row.model.id)).toEqual(["claude-sonnet-4", "claude-opus-4"]);
  });

  it("filters by provider, id or name, ignoring case and surrounding blanks", () => {
    const ids = (query: string) =>
      groupModels(LIST, query, null, NO_DEFAULTS).flatMap((group) => group.rows.map((row) => row.model.id));
    expect(ids("son")).toEqual(["claude-sonnet-4"]);
    expect(ids("  OPENAI ")).toEqual(["gpt-5", "gpt-5-mini"]);
    expect(ids("opus 4")).toEqual(["claude-opus-4"]);
    expect(ids("nothing")).toEqual([]);
    expect(groupModels(LIST, "nothing", null, NO_DEFAULTS)).toEqual([]);
  });

  it("marks exactly the current row, matching provider and id together", () => {
    const groups = groupModels(LIST, "", { provider: "anthropic", id: "claude-opus-4" }, NO_DEFAULTS);
    const current = groups.flatMap((group) => group.rows.filter((row) => row.current));
    expect(current.map((row) => `${row.model.provider}/${row.model.id}`)).toEqual([
      "anthropic/claude-opus-4",
    ]);
    const other = groupModels(LIST, "", { provider: "zeta", id: "gpt-5" }, NO_DEFAULTS);
    expect(other.flatMap((group) => group.rows).filter((row) => row.current)).toEqual([]);
  });

  it("marks the default row only when both the provider and the model id match", () => {
    const groups = groupModels(LIST, "", null, { provider: "openai", model: "gpt-5" });
    const defaults = groups.flatMap((group) => group.rows.filter((row) => row.isDefault));
    expect(defaults.map((row) => `${row.model.provider}/${row.model.id}`)).toEqual(["openai/gpt-5"]);
    expect(
      groupModels(LIST, "", null, null)
        .flatMap((group) => group.rows)
        .some((row) => row.isDefault),
    ).toBe(false);
  });
});
