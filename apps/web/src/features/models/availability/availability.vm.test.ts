import { describe, expect, it } from "vitest";
import type { AvailableState } from "../picker/use-available-models.ts";
import { toPickerModel } from "../picker/model-picker.vm.ts";
import { BASE, overviewOfWorld, type World } from "./availability-world.ts";
import { extensionRows, modeOf, previewGroups, providerRows, unmatchedWarnings } from "./availability.vm.ts";

const world = (selected: string[] | null): World => ({
  providers: BASE,
  selected: selected === null ? null : new Set(selected),
  dead: [],
  scope: "global",
});

const ready = (ids: ReadonlyArray<readonly [string, string]>): AvailableState => ({
  status: "ready",
  models: ids.map(([provider, id]) => toPickerModel({ provider, id, name: id, reasoning: false })),
  labels: new Map([
    ["openai", "OpenAI"],
    ["mine", "Mine"],
  ]),
  origin: "scope",
  truncated: false,
});

describe("mode", () => {
  it("is all when no list exists and a selection when one does", () => {
    expect(modeOf(null)).toBe("all");
    expect(modeOf([])).toBe("selection");
    expect(modeOf(["openai/*"])).toBe("selection");
  });
});

describe("provider rows", () => {
  const rows = (available: AvailableState) =>
    providerRows(overviewOfWorld(world(["openai/gpt-a", "anthropic/claude-a"])).providers, available);

  it("counts the offered models of a provider as the preview lists them", () => {
    const list = rows(ready([["openai", "gpt-a"]]));
    expect(list.find((row) => row.id === "openai")).toMatchObject({ offered: 1, total: 2, connected: true });
  });

  it("marks a provider without a connected auth as not connected with zero offered", () => {
    const row = rows(ready([["openai", "gpt-a"]])).find((one) => one.id === "anthropic");
    expect(row).toMatchObject({ connected: false, offered: 0, total: 2 });
    expect(row?.models.map((model) => model.enabled)).toEqual([true, false]);
  });

  it("never counts a model of an unconnected provider the preview returned", () => {
    const row = rows(ready([["anthropic", "claude-a"]])).find((one) => one.id === "anthropic");
    expect(row?.offered).toBe(0);
  });

  it("has no offered count while the preview is not ready", () => {
    expect(rows({ status: "loading" }).map((row) => row.offered)).toEqual([null, 0, null]);
  });

  it("strips hidden characters from provider and model names", () => {
    const providers = overviewOfWorld(world(null)).providers.map((one, index) =>
      index === 0
        ? { ...one, name: "Open\u202eAI", models: one.models.map((m) => ({ ...m, name: "g\u200bpt" })) }
        : one,
    );
    const row = providerRows(providers, { status: "loading" })[0];
    expect(row?.name).toBe("OpenAI");
    expect(row?.models[0]?.label).toBe("gpt");
  });
});

describe("unmatched warnings", () => {
  it("keeps only the No model matches form, without hidden characters", () => {
    expect(
      unmatchedWarnings([
        'No model matches "nothing/here".',
        "Something else.",
        'No model matches "a\u202eb".',
      ]),
    ).toEqual(['No model matches "nothing/here".', 'No model matches "ab".']);
  });
});

describe("preview groups", () => {
  it("groups by provider in the order of the answer", () => {
    const groups = previewGroups(
      ready([
        ["mine", "m1"],
        ["openai", "gpt-a"],
        ["mine", "m2"],
      ]),
    );
    expect(groups.map((group) => [group.provider, group.rows.map((row) => row.id)])).toEqual([
      ["mine", ["m1", "m2"]],
      ["openai", ["gpt-a"]],
    ]);
  });
  it("is empty when the preview is not ready", () => {
    expect(previewGroups({ status: "loading" })).toEqual([]);
  });
});

describe("extension rows", () => {
  const answer = {
    providers: [
      {
        id: "ext\u202ea",
        name: "E\u200bxt",
        models: [{ provider: "x", id: "m\u200b1", name: "M", reasoning: false }],
        modelsTruncated: true,
      },
      { id: "mine", name: "Mine", models: [], modelsTruncated: false },
    ],
    truncated: true,
    failed: false,
  };

  it("cleans provider and model ids as well as names", () => {
    const rows = extensionRows(answer, BASE);
    expect(rows[0]).toMatchObject({ id: "exta", name: "Ext", modelsTruncated: true });
    expect(rows[0]?.models[0]).toMatchObject({ id: "m1" });
  });

  it("marks a provider that re-registers one of models.json, and only that one", () => {
    expect(extensionRows(answer, BASE).map((row) => row.overrides)).toEqual([false, true]);
  });
});
