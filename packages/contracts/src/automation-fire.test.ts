import { describe, expect, it } from "vitest";
import { DryRunResult, FireView, methods, TOKEN_PERMISSIONS } from "./index.ts";

const dry = {
  verdict: "fire",
  reasons: [],
  tools: ["read"],
  profile: { preset: "read-only", mode: "supervised", tainted: false, editsUnasked: false },
  cwd: "/x",
  prompt: "p",
  precheck: null,
  budget: { spentUsd: 0, budgetUsd: 5 },
  tokens: "none",
  feed: null,
};
const fire = {
  id: 1,
  firstAt: 1,
  at: 2,
  count: 12,
  source: "schedule",
  verdict: "precheck",
  detail: "exit 1",
  taskId: null,
  taskState: null,
  durationMs: null,
  costUsd: null,
};

describe("manual fire, dry-run and journal methods (M10R63 to M10R65)", () => {
  it("lets a token fire and dry-run (operate) and read the journal, and fire is a mutation", () => {
    expect(TOKEN_PERMISSIONS).toContain("automation:operate");
    expect(methods["automation.fire"]).toMatchObject({ permission: "automation:operate", idempotent: false });
    expect(methods["automation.dryRun"]).toMatchObject({
      permission: "automation:operate",
      idempotent: true,
    });
    expect(methods["automation.journal"]).toMatchObject({ permission: "automation:read", idempotent: true });
  });

  it("keeps the payload out of the receipt of a fire", () => {
    expect(methods["automation.fire"].sensitiveParams).toEqual(["triggerId"]);
  });

  it("declares the refusals a fire can answer, and budget_reached on a retry (the runner can answer it)", () => {
    expect(methods["automation.fire"].errors).toEqual(
      expect.arrayContaining(["not_found", "automation_paused", "budget_reached", "rate_limited"]),
    );
    expect(methods["automation.tasks.retry"].errors).toContain("budget_reached");
  });

  it("bounds the payload at 64 KiB of UTF-8 and refuses a field that raises a cap", () => {
    const params = methods["automation.fire"].params;
    expect(params.safeParse({ triggerId: "t", payload: "a".repeat(65_536) }).success).toBe(true);
    expect(params.safeParse({ triggerId: "t", payload: "a".repeat(65_537) }).success).toBe(false);
    expect(params.safeParse({ triggerId: "t", payload: "é".repeat(32_769) }).success).toBe(false);
    expect(params.safeParse({ triggerId: "t", dailyBudgetUsd: 9 }).success).toBe(false);
  });

  it("answers fired with a task and precheck or error with a closed detail", () => {
    const result = methods["automation.fire"].result;
    expect(result.safeParse({ verdict: "fired", taskId: "k" }).success).toBe(true);
    expect(result.safeParse({ verdict: "precheck", detail: "exit 1" }).success).toBe(true);
    expect(result.safeParse({ verdict: "fired" }).success).toBe(false);
    expect(result.safeParse({ verdict: "budget", detail: "x" }).success).toBe(false);
  });

  it("needs a trigger or a draft to dry-run", () => {
    const params = methods["automation.dryRun"].params;
    expect(params.safeParse({}).success).toBe(false);
    expect(params.safeParse({ triggerId: "t" }).success).toBe(true);
  });

  it("describes a dry-run result with a closed precheck, no tokens and a feed note", () => {
    expect(DryRunResult.safeParse(dry).success).toBe(true);
    expect(DryRunResult.safeParse({ ...dry, precheck: "not_run_token", feed: "not_fetched" }).success).toBe(
      true,
    );
    expect(
      DryRunResult.safeParse({
        ...dry,
        precheck: { verdict: "skip", exitCode: 1, durationMs: 2, output: "o" },
      }).success,
    ).toBe(true);
    expect(DryRunResult.safeParse({ ...dry, tokens: "some" }).success).toBe(false);
    for (const word of ["not_run_paused", "not_run_budget"])
      expect(DryRunResult.safeParse({ ...dry, precheck: word, feed: "not_fetched" }).success).toBe(true);
    expect(DryRunResult.safeParse({ ...dry, precheck: "not_run" }).success).toBe(false);
  });

  it("pages the journal by 50 and describes a collapsed line", () => {
    expect(FireView.safeParse(fire).success).toBe(true);
    const result = methods["automation.journal"].result;
    expect(result.safeParse({ entries: Array.from({ length: 50 }, () => fire), hasMore: true }).success).toBe(
      true,
    );
    expect(result.safeParse({ entries: Array.from({ length: 51 }, () => fire), hasMore: true }).success).toBe(
      false,
    );
    expect(methods["automation.journal"].params.safeParse({ triggerId: "t", before: 0 }).success).toBe(false);
  });
});
