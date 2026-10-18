import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Step {
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, unknown>;
}
interface Job {
  readonly "timeout-minutes"?: number;
  readonly needs?: string;
  readonly steps: readonly Step[];
}

const ci = parse(readFileSync(resolve(import.meta.dirname, "..", ".github/workflows/ci.yml"), "utf8")) as {
  jobs: Record<string, Job>;
};

describe("the budgets job (M13 B1)", () => {
  const job = ci.jobs["budgets"];

  it("runs the bundle check, then the timing budgets as its last step", () => {
    const runs = (job?.steps ?? []).flatMap((step) => (step.run === undefined ? [] : [step.run]));
    expect(runs.slice(-2)).toEqual(["pnpm budgets", "pnpm test:budget"]);
    expect(job?.steps.at(-1)?.run).toBe("pnpm test:budget");
  });

  it("has a 20 minute timeout (the corpus build takes 65 s)", () => {
    expect(job?.["timeout-minutes"]).toBe(20);
  });

  it("installs dependencies and downloads dist before the checks", () => {
    const steps = job?.steps ?? [];
    const setup = steps.find((step) => step.uses === "./.github/actions/setup");
    expect(setup).toBeDefined();
    expect(setup?.with?.["install"]).toBeUndefined();
    const download = steps.findIndex((step) => step.uses?.startsWith("actions/download-artifact@"));
    expect(download).toBeGreaterThan(steps.indexOf(setup as Step));
    expect(download).toBeLessThan(steps.findIndex((step) => step.run === "pnpm budgets"));
    expect(steps[download]?.with).toEqual({ name: "dist", path: "." });
  });
});
