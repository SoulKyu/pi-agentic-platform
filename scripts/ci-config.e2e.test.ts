import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The `e2e` job of ci.yml (M13R5: CI runs the journeys with local browsers once the repository is public).
// scripts/ci-config.test.ts belongs to A1; this file pins only this job.
interface Step {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly if?: string;
  readonly env?: Record<string, unknown>;
  readonly with?: Record<string, unknown>;
  readonly "continue-on-error"?: unknown;
}
interface Job {
  readonly needs?: string;
  readonly "runs-on"?: string;
  readonly "timeout-minutes"?: number;
  readonly env?: Record<string, unknown>;
  readonly "continue-on-error"?: unknown;
  readonly steps: readonly Step[];
}
interface Workflow {
  readonly env?: Record<string, unknown>;
  readonly jobs: Record<string, Job>;
}

const text = readFileSync(resolve(import.meta.dirname, "..", ".github/workflows/ci.yml"), "utf8");
const workflow = parse(text) as Workflow;
const job = workflow.jobs["e2e"];
const steps = job?.steps ?? [];
const index = (match: (step: Step) => boolean): number => steps.findIndex(match);

describe("the e2e job of ci.yml", () => {
  it("exists, runs after the build, on the pinned runner, with a 25 minute timeout", () => {
    expect(job).toBeDefined();
    expect(job?.needs).toBe("build");
    expect(job?.["runs-on"]).toBe("ubuntu-24.04");
    expect(job?.["timeout-minutes"]).toBe(25);
  });

  it("can fail the build: no continue-on-error anywhere in the job", () => {
    expect(job?.["continue-on-error"]).toBeUndefined();
    for (const step of steps) expect(step["continue-on-error"], step.name ?? step.run).toBeUndefined();
  });

  it("checks out without the token, then sets up, then downloads the dist artifact the build uploaded", () => {
    const checkout = index((step) => step.uses?.startsWith("actions/checkout@") === true);
    const setup = index((step) => step.uses === "./.github/actions/setup");
    const download = index((step) => step.uses?.startsWith("actions/download-artifact@") === true);
    expect(checkout).toBe(0);
    expect(steps[checkout]?.with?.["persist-credentials"]).toBe(false);
    expect(setup).toBeGreaterThan(checkout);
    expect(download).toBeGreaterThan(setup);
    expect(steps[download]?.with).toEqual({ name: "dist", path: "." });
  });

  it("installs both browsers with their system dependencies before the suite, then runs pnpm test:e2e", () => {
    const install = index((step) => step.run?.includes("playwright install") === true);
    const suite = index((step) => step.run === "pnpm test:e2e");
    expect(install).toBeGreaterThan(
      index((step) => step.uses?.startsWith("actions/download-artifact@") === true),
    );
    expect(suite).toBeGreaterThan(install);
    const command = steps[install]?.run ?? "";
    expect(command).toContain("pnpm exec playwright install");
    expect(command).toContain("--with-deps");
    expect(command).toMatch(/\bchromium\b/);
    expect(command).toMatch(/\bwebkit\b/);
  });

  it("uploads playwright-report when the suite fails, and only then", () => {
    const suite = index((step) => step.run === "pnpm test:e2e");
    const upload = steps.at(-1);
    expect(index((step) => step.uses?.startsWith("actions/upload-artifact@") === true)).toBe(
      steps.length - 1,
    );
    expect(steps.length - 1).toBeGreaterThan(suite);
    expect(upload?.if).toBe("failure()");
    expect(upload?.with?.["path"]).toBe("scripts/e2e/playwright-report");
    expect(upload?.with?.["name"]).toBe("playwright-report");
  });

  it("leaves PAP_E2E_MODE and PAP_E2E_WS unset, so CI uses the browsers it installed", () => {
    for (const env of [workflow.env, job?.env, ...steps.map((step) => step.env)]) {
      expect(Object.keys(env ?? {})).not.toContain("PAP_E2E_MODE");
      expect(Object.keys(env ?? {})).not.toContain("PAP_E2E_WS");
    }
    const section = text.slice(text.indexOf("\n  e2e:"));
    expect(section).not.toContain("PAP_E2E_MODE");
    expect(section).not.toContain("PAP_E2E_WS");
  });

  it("pins every action of the job by commit SHA with the version in a comment, like the other jobs", () => {
    const section = text.slice(text.indexOf("\n  e2e:"));
    const uses = [...section.matchAll(/^\s*(?:- )?uses:\s*(\S+)(?:\s+#\s*(\S+))?\s*$/gm)]
      .map(([, ref, comment]) => ({ ref, comment }))
      .filter(({ ref }) => !ref?.startsWith("./"));
    expect(uses.length).toBeGreaterThanOrEqual(3);
    for (const { ref, comment } of uses) {
      expect(ref).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      expect(comment).toMatch(/^v\d+$/);
    }
  });
});
