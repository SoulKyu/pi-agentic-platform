import type { SessionCost, SessionLoadout } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { EMPTY_VIEW, type SessionView } from "../../stores/session-reducer.ts";
import { toMessageView } from "../../stores/row-view.ts";
import { costLineOf, meterOf } from "./usage.vm.ts";

const loadout = (contextWindow: number | undefined, billing?: "api" | "subscription"): SessionLoadout => ({
  model: { provider: "p", id: "m", name: "M", reasoning: false, ...(contextWindow ? { contextWindow } : {}) },
  thinkingLevel: "off",
  levels: ["off"],
  preset: "configured",
  tools: [],
  toolsTruncated: false,
  ...(billing ? { billing } : {}),
});
const assistant = (totalTokens: number, stopReason = "stop", at = 1) =>
  toMessageView({ role: "assistant", content: "x", timestamp: at, stopReason, usage: { totalTokens } });
const summary = (role: "compactionSummary" | "branchSummary", at: number) =>
  toMessageView({ role, summary: "s", timestamp: at, tokensBefore: 10 });
const viewOf = (patch: Partial<SessionView>): SessionView => ({ ...EMPTY_VIEW, ...patch });
const messages = (...list: Array<ReturnType<typeof toMessageView>>) => list.flatMap((m) => (m ? [m] : []));

describe("meterOf", () => {
  it("41 000 of 200 000 tokens: shown, not soon", () => {
    expect(meterOf(viewOf({ loadout: loadout(200_000), messages: messages(assistant(41_000)) }))).toEqual({
      used: 41_000,
      window: 200_000,
      soon: false,
    });
  });

  it("exactly 80 % is soon, 79.99 % is not", () => {
    const at = (used: number) =>
      meterOf(viewOf({ loadout: loadout(100_000), messages: messages(assistant(used)) }));
    expect(at(80_000)?.soon).toBe(true);
    expect(at(79_990)?.soon).toBe(false);
  });

  it("usage over the window is soon, and used stays the real number", () => {
    const meter = meterOf(viewOf({ loadout: loadout(100_000), messages: messages(assistant(130_000)) }));
    expect(meter).toEqual({ used: 130_000, window: 100_000, soon: true });
  });

  it("no loadout, no contextWindow, or no usable reply: hidden", () => {
    expect(meterOf(viewOf({ loadout: null, messages: messages(assistant(5)) }))).toBeNull();
    expect(meterOf(viewOf({ loadout: loadout(undefined), messages: messages(assistant(5)) }))).toBeNull();
    expect(meterOf(viewOf({ loadout: loadout(1000), messages: [] }))).toBeNull();
    expect(meterOf(viewOf({ loadout: loadout(1000), messages: messages(assistant(5, "error")) }))).toBeNull();
  });

  it("a compaction or a branch summary newer than the last usage hides it until the next reply", () => {
    const base = { loadout: loadout(1000) };
    for (const role of ["compactionSummary", "branchSummary"] as const) {
      expect(
        meterOf(viewOf({ ...base, messages: messages(assistant(5, "stop", 1), summary(role, 2)) })),
      ).toBeNull();
      expect(
        meterOf(
          viewOf({
            ...base,
            messages: messages(assistant(5, "stop", 1), summary(role, 2), assistant(7, "stop", 3)),
          }),
        )?.used,
      ).toBe(7);
    }
  });

  it("an aborted newest reply falls back to the reply before it", () => {
    const list = messages(assistant(300, "stop", 1), assistant(900, "aborted", 2));
    expect(meterOf(viewOf({ loadout: loadout(1000), messages: list }))?.used).toBe(300);
  });
});

describe("costLineOf", () => {
  const cost = (patch: Partial<SessionCost> = {}): SessionCost => ({
    sessionUsd: 0.42,
    runUsd: null,
    billing: "api",
    ...patch,
  });

  it("run shown only while a run is open; API-equivalent from cost.billing or loadout.billing", () => {
    expect(costLineOf(viewOf({ cost: null }))).toBeNull();
    expect(costLineOf(viewOf({ cost: cost() }))).toEqual({ session: 0.42, run: null, apiEquivalent: false });
    expect(costLineOf(viewOf({ cost: cost({ runUsd: 0.05 }) }))).toEqual({
      session: 0.42,
      run: 0.05,
      apiEquivalent: false,
    });
    expect(costLineOf(viewOf({ cost: cost({ billing: "subscription" }) }))?.apiEquivalent).toBe(true);
    expect(costLineOf(viewOf({ cost: cost(), loadout: loadout(1000, "subscription") }))?.apiEquivalent).toBe(
      true,
    );
    expect(
      costLineOf(viewOf({ cost: cost({ billing: "unknown" }), loadout: loadout(1000, "api") }))
        ?.apiEquivalent,
    ).toBe(false);
  });
});
