import { describe } from "vitest";
import { models, off, type Row, runRows } from "../../testing/enabled-plans.ts";

// Prune, clear and resync, and the bounds: the second half of the planner's table (`enabled-models.test.ts`).
const PRUNE_ROWS: readonly Row[] = [
  {
    name: "prune drops only the unmatched entries of a provider it knows, and keeps those it cannot judge",
    patterns: ["foo/*", "anthropic/claude-a", "anthropic/gone", "unknown-x", "p/*:low", "p/zz:high"],
    op: { op: "prune" },
    expected: ["foo/*", "anthropic/claude-a", "unknown-x", "p/*:low"],
  },
  {
    name: "prune with nothing to drop changes nothing",
    patterns: ["anthropic/*", "p/m1"],
    op: { op: "prune" },
    expected: ["anthropic/*", "p/m1"],
  },
  {
    name: "prune of a list of known providers' entries that match nothing clears the key",
    patterns: ["anthropic/gone", "openai/gone-*"],
    op: { op: "prune" },
    expected: undefined,
  },
  {
    name: "prune keeps an entry an extension may match (claude-bridge/x), even when nothing else is left",
    patterns: ["claude-bridge/x", "anthropic/gone"],
    op: { op: "prune" },
    expected: ["claude-bridge/x"],
  },
  {
    name: "prune judges with the providers it is given, models or not",
    patterns: ["empty/x", "foo/y"],
    op: { op: "prune" },
    expected: ["foo/y"],
    catalog: { models: models("p", ["m1"]), providers: ["p", "empty"] },
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

describe("planEnabledEdit: table (prune, clear, resync, bounds)", () => {
  runRows(PRUNE_ROWS);
});
