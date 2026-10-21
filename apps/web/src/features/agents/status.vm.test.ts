import type { AgentStatus, TaskView, TriggerView } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { ago, budgetVm, formatTokens, panelLayout, taskRows, triggerRows } from "./status.vm.ts";

const today = (patch: Partial<AgentStatus["today"]> = {}): AgentStatus["today"] => ({
  usd: 1.2,
  tokens: 12_400,
  budgetUsd: null,
  budgetTokens: null,
  ...patch,
});

describe("the budget meters (M11R125, owner m14)", () => {
  it("has no bars and says what was spent when the agent has no budget (the default)", () => {
    expect(budgetVm(today())).toEqual({ kind: "none", spent: "$1.20 · 12.4k" });
  });

  it("draws a tokens bar and a cost bar with their labels when both budgets are set", () => {
    expect(budgetVm(today({ budgetUsd: 5, budgetTokens: 50_000 }))).toEqual({
      kind: "set",
      over: false,
      meters: [
        { kind: "tokens", value: 12_400, max: 50_000, valueText: "12.4k / 50k" },
        { kind: "cost", value: 1.2, max: 5, valueText: "$1.20 / $5.00" },
      ],
    });
  });

  it("draws only the half that is set", () => {
    const vm = budgetVm(today({ budgetUsd: 5 }));
    expect(vm.kind === "set" && vm.meters.map((meter) => meter.kind)).toEqual(["cost"]);
  });

  it("flags the whole budget when either half is past its budget, and carries no flag per bar", () => {
    const cost = budgetVm(today({ usd: 6, budgetUsd: 5, budgetTokens: 50_000 }));
    expect(cost.kind === "set" && cost.over).toBe(true);
    const tokens = budgetVm(today({ tokens: 60_000, budgetUsd: 5, budgetTokens: 50_000 }));
    expect(tokens.kind === "set" && tokens.over).toBe(true);
    expect(cost.kind === "set" && cost.meters.map((meter) => Object.keys(meter).sort())).toEqual([
      ["kind", "max", "value", "valueText"],
      ["kind", "max", "value", "valueText"],
    ]);
  });

  it("does not flag a spend exactly at the budget", () => {
    const vm = budgetVm(today({ usd: 5, budgetUsd: 5 }));
    expect(vm.kind === "set" && vm.over).toBe(false);
  });

  it("writes token counts short", () => {
    expect([0, 999, 1000, 1500, 12_400, 999_999, 1_000_000, 2_500_000].map(formatTokens)).toEqual([
      "0",
      "999",
      "1k",
      "1.5k",
      "12.4k",
      "1M",
      "1M",
      "2.5M",
    ]);
  });
});

const task = (patch: Partial<TaskView>): TaskView => ({
  id: "t1",
  triggerId: null,
  triggerName: "",
  projectId: null,
  state: "done",
  reason: null,
  origin: "agent",
  title: "Tidy the repo",
  detail: null,
  createdAt: 1000,
  startedAt: 2000,
  endedAt: 3000,
  sessionId: "s9",
  needsInput: false,
  costUsd: 0,
  resetAt: null,
  toolsReleased: false,
  ...patch,
});

describe("task and trigger rows", () => {
  it("maps each state to a tone and a word, a question waiting to attention", () => {
    const rows = taskRows([
      task({ id: "a", state: "running", needsInput: true }),
      task({ id: "b", state: "failed" }),
      task({ id: "c", state: "queued", sessionId: null, startedAt: null, endedAt: null }),
    ]);
    expect(rows.map((row) => [row.tone, row.stateWord, row.at, row.sessionId])).toEqual([
      ["att", "input", 3000, "s9"],
      ["err", "failed", 3000, "s9"],
      ["mut", "queued", 1000, null],
    ]);
  });

  it("removes hidden characters from a task title and a trigger name", () => {
    expect(taskRows([task({ title: "Tidy\u202e the\u200b repo" })])[0]?.title).toBe("Tidy the repo");
    const trigger = {
      id: "g1",
      name: "Nightly\u200b",
      enabled: true,
      source: { type: "manual" },
    } as unknown as TriggerView;
    expect(triggerRows([trigger])).toEqual([
      { id: "g1", name: "Nightly", glyph: "▸", enabled: true, canFire: true },
    ]);
  });

  it("can fire an enabled trigger of any source type and no disabled one", () => {
    const types = ["manual", "schedule", "webhook", "feed"];
    const rows = (enabled: boolean) =>
      triggerRows(
        types.map((type) => ({ id: type, name: type, enabled, source: { type } }) as unknown as TriggerView),
      );
    expect(rows(true).map((row) => row.canFire)).toEqual([true, true, true, true]);
    expect(rows(false).map((row) => row.canFire)).toEqual([false, false, false, false]);
  });
});

describe("the layout and the times", () => {
  it("is a column when wide, a pane between, a sheet on the phone", () => {
    expect([panelLayout(true, false), panelLayout(false, false), panelLayout(false, true)]).toEqual([
      "side",
      "pane",
      "sheet",
    ]);
  });

  it("writes recency", () => {
    const now = Date.UTC(2026, 9, 16, 12);
    expect([30_000, 5 * 60_000, 3 * 3_600_000, 86_400_000].map((d) => ago(now, now - d, "en"))).toEqual([
      "now",
      "5 minutes ago",
      "3 hours ago",
      "yesterday",
    ]);
  });
});
