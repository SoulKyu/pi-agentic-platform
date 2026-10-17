import { describe, expect, it } from "vitest";
import { choiceLabels, levelsFor, type ModelChoice } from "./model-fields.vm.ts";

const choice = (provider: string, id: string, name: string, reasoning = true): ModelChoice => ({
  provider,
  id,
  name,
  reasoning,
});
const format = (name: string, provider: string) => `${name} (${provider})`;

describe("choiceLabels", () => {
  it("shows the name alone while no other model has it", () => {
    expect(
      choiceLabels([choice("anthropic", "sonnet", "Sonnet"), choice("openai", "gpt", "GPT")], format),
    ).toEqual(["Sonnet", "GPT"]);
  });

  it("adds the provider to every model whose name another provider shares", () => {
    expect(
      choiceLabels(
        [
          choice("anthropic", "sonnet", "Sonnet"),
          choice("bedrock", "sonnet", "Sonnet"),
          choice("openai", "gpt", "GPT"),
        ],
        format,
      ),
    ).toEqual(["Sonnet (anthropic)", "Sonnet (bedrock)", "GPT"]);
  });

  it("falls back on the id for a model without a name, and compares that", () => {
    expect(choiceLabels([choice("a", "m1", ""), choice("b", "m1", "")], format)).toEqual([
      "m1 (a)",
      "m1 (b)",
    ]);
  });
});

describe("levelsFor", () => {
  it("offers every level to a model that reasons, and to a model nobody listed", () => {
    expect(levelsFor(choice("a", "m", "M"))).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(levelsFor(undefined)).toHaveLength(7);
  });

  it("offers only off to a model without reasoning (M7R45)", () => {
    expect(levelsFor(choice("a", "m", "M", false))).toEqual(["off"]);
  });
});
