import { describe, expect, it } from "vitest";
import * as picker from "./index.ts";
import { groupAndRank, modelKey, toPickerModel, type PickerModel } from "./model-picker.vm.ts";

const model = (provider: string, id: string, name = id): PickerModel => ({
  provider,
  id,
  name,
  reasoning: false,
});
const LABELS = new Map([
  ["anthropic", "Anthropic"],
  ["openai", "OpenAI"],
  ["mine", "My server"],
]);
const SOURCE = [
  model("openai", "gpt-5", "GPT 5"),
  model("anthropic", "claude-opus", "Claude Opus"),
  model("openai", "gpt-4", "GPT 4"),
  model("anthropic", "claude-sonnet", "Claude Sonnet"),
  model("mine", "local-1", "Local one"),
];
const keys = (groups: ReturnType<typeof groupAndRank>) =>
  groups.map((group) => [group.provider, group.rows.map((row) => `${row.provider}/${row.id}`)]);

describe("modelKey", () => {
  it("is separator-safe: a/b + c differs from a + b/c", () => {
    expect(modelKey({ provider: "anthropic", id: "claude-opus" })).toBe('["anthropic","claude-opus"]');
    expect(modelKey({ provider: "a/b", id: "c" })).not.toBe(modelKey({ provider: "a", id: "b/c" }));
  });
});

describe("groupAndRank", () => {
  it("keeps the source order of groups and of rows within a group for an empty query", () => {
    expect(keys(groupAndRank(SOURCE, LABELS, ""))).toEqual([
      ["openai", ["openai/gpt-5", "openai/gpt-4"]],
      ["anthropic", ["anthropic/claude-opus", "anthropic/claude-sonnet"]],
      ["mine", ["mine/local-1"]],
    ]);
    expect(keys(groupAndRank(SOURCE, LABELS, "   "))).toEqual(keys(groupAndRank(SOURCE, LABELS, "")));
  });

  it("labels a group with the provider's name, or its id when the daemon sent no name", () => {
    const groups = groupAndRank([...SOURCE, model("other", "x")], LABELS, "");
    expect(groups.map((group) => group.label)).toEqual(["OpenAI", "Anthropic", "My server", "other"]);
  });

  it("ranks a word prefix above a substring", () => {
    const rows = [model("p", "reasoning-x"), model("p", "claude-sonnet")];
    expect(keys(groupAndRank(rows, LABELS, "son"))).toEqual([["p", ["p/claude-sonnet", "p/reasoning-x"]]]);
  });

  it("ranks exact above prefix above word boundary above substring", () => {
    const rows = [model("p", "xsonx"), model("p", "a-son"), model("p", "sonic"), model("p", "son")];
    expect(keys(groupAndRank(rows, new Map(), "son"))).toEqual([
      ["p", ["p/son", "p/sonic", "p/a-son", "p/xsonx"]],
    ]);
  });

  it("keeps the source order between rows of the same rank", () => {
    const rows = [model("p", "b-son"), model("p", "a-son")];
    expect(keys(groupAndRank(rows, new Map(), "son"))).toEqual([["p", ["p/b-son", "p/a-son"]]]);
  });

  it("needs every token to match provider, id or name", () => {
    expect(keys(groupAndRank(SOURCE, LABELS, "anthropic opus"))).toEqual([
      ["anthropic", ["anthropic/claude-opus"]],
    ]);
    expect(groupAndRank(SOURCE, LABELS, "anthropic gpt")).toEqual([]);
  });

  it("matches provider id, model id and name, case-insensitively", () => {
    expect(keys(groupAndRank(SOURCE, LABELS, "OPENAI"))).toEqual([
      ["openai", ["openai/gpt-5", "openai/gpt-4"]],
    ]);
    expect(keys(groupAndRank(SOURCE, LABELS, "CLAUDE-SON"))).toEqual([
      ["anthropic", ["anthropic/claude-sonnet"]],
    ]);
    expect(keys(groupAndRank(SOURCE, LABELS, "local one"))).toEqual([["mine", ["mine/local-1"]]]);
  });

  it("keeps groups in the order of the source's first appearance, whatever the ranking", () => {
    const rows = [model("zeta", "a-son"), model("alpha", "son")];
    expect(groupAndRank(rows, new Map(), "son").map((group) => group.provider)).toEqual(["zeta", "alpha"]);
  });

  it("answers [] when nothing matches", () => {
    expect(groupAndRank(SOURCE, LABELS, "zzz")).toEqual([]);
    expect(groupAndRank([], LABELS, "")).toEqual([]);
  });

  it("strips hidden characters from a provider label it falls back to", () => {
    const groups = groupAndRank([model("pro\u202evider", "x")], new Map(), "");
    expect(groups[0]?.label).toBe("provider");
  });

  it("does linear work for 2000 models: every field of a model is read once", () => {
    const reads = { count: 0 };
    const counted = (index: number): PickerModel => {
      const fields = { provider: `p${index % 7}`, id: `model-${index}`, name: `Model ${index}` };
      return {
        get provider() {
          reads.count += 1;
          return fields.provider;
        },
        get id() {
          reads.count += 1;
          return fields.id;
        },
        get name() {
          reads.count += 1;
          return fields.name;
        },
        reasoning: false,
      };
    };
    for (const size of [1000, 2000]) {
      const rows = Array.from({ length: size }, (_, index) => counted(index));
      reads.count = 0;
      groupAndRank(rows, new Map(), "model 1");
      expect(reads.count).toBe(3 * size);
      reads.count = 0;
      groupAndRank(rows, new Map(), "");
      expect(reads.count).toBe(size);
    }
  });
});

describe("toPickerModel", () => {
  const summary = { provider: "anthropic", id: "claude-opus", name: "Claude Opus", reasoning: true };

  it("copies the fields a row needs and leaves out the rest", () => {
    expect(toPickerModel({ ...summary, contextWindow: 200000, images: true })).toEqual({
      ...summary,
      contextWindow: 200000,
    });
    expect("contextWindow" in toPickerModel(summary)).toBe(false);
  });

  it("hostile-name: removes bidi and zero-width characters and clips a long name to 256", () => {
    const hostile = `evil${String.fromCodePoint(0x202e)}name${String.fromCodePoint(0x200b)}!`;
    expect(toPickerModel({ ...summary, name: hostile }).name).toBe("evilname!");
    const long = toPickerModel({ ...summary, name: "x".repeat(5000) }).name;
    expect(long).toHaveLength(256);
    expect(long.endsWith("…")).toBe(true);
  });

  it("leaves the provider and id alone: they are the key a choice is saved under", () => {
    const odd = toPickerModel({ ...summary, provider: "my/provider", id: "a b" });
    expect(modelKey(odd)).toBe('["my/provider","a b"]');
  });
});

describe("the picker's public surface", () => {
  it("exports the view-model, the hook and the field, and nothing else", () => {
    expect(Object.keys(picker).sort()).toEqual([
      "ModelPickerField",
      "groupAndRank",
      "modelKey",
      "toPickerModel",
      "useAvailableModels",
    ]);
  });
});
