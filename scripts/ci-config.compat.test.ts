import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { REPO } from "./release-bed.ts";

const root = REPO;
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const BYPASS = /minimum[-_]?release[-_]?age(?:\s*[=:]\s*|\s+)["']?0\b/i;

const workflowFiles = readdirSync(resolve(root, ".github/workflows")).filter((name) => name.endsWith(".yml"));

describe("the release age rule is never bypassed", () => {
  it("recognizes the bypass spellings", () => {
    for (const text of [
      "--config.minimum-release-age=0",
      "minimum-release-age=0",
      "minimumReleaseAge: 0",
      "--minimum-release-age 0",
      "npm_config_minimum_release_age=0",
      "PNPM_CONFIG_MINIMUM_RELEASE_AGE=0",
    ]) {
      expect(BYPASS.test(text), text).toBe(true);
    }
    expect(BYPASS.test("minimumReleaseAge: 4320")).toBe(false);
    expect(BYPASS.test("--minimum-release-age=0123")).toBe(false);
  });

  it("is absent from every workflow", () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
    for (const name of workflowFiles) expect(read(`.github/workflows/${name}`), name).not.toMatch(BYPASS);
  });

  it("is absent from the package.json scripts", () => {
    const { scripts } = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    for (const [name, command] of Object.entries(scripts)) expect(command, name).not.toMatch(BYPASS);
  });
});

describe("the nightly Pi job", () => {
  interface Step {
    readonly run?: string;
  }
  const steps = (): readonly Step[] => {
    const wf = parse(read(".github/workflows/pi-compat.yml")) as { jobs: Record<string, { steps: Step[] }> };
    return Object.values(wf.jobs)[0]?.steps ?? [];
  };

  it("picks the version with the bump script before it installs", () => {
    const list = steps();
    const bump = list.findIndex((step) =>
      step.run?.includes("node --disable-warning=ExperimentalWarning scripts/pi-compat-bump.ts"),
    );
    const install = list.findIndex((step) => step.run?.includes("pnpm install --no-frozen-lockfile"));
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(bump);
  });

  it("is dispatch-only until the v1 flip, then dispatch plus the nightly schedule (M13R33)", () => {
    const wf = parse(read(".github/workflows/pi-compat.yml")) as { on: Record<string, unknown> };
    expect([["workflow_dispatch"], ["schedule", "workflow_dispatch"]]).toContainEqual(
      Object.keys(wf.on).toSorted(),
    );
  });

  it("installs under the repository's own release age", () => {
    const install = steps().find((step) => step.run?.includes("pnpm install --no-frozen-lockfile"));
    expect(install?.run?.trim()).toBe("pnpm install --no-frozen-lockfile");
  });
});
