import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const read = (path: string) => readFileSync(resolve(import.meta.dirname, "..", path), "utf8");

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
interface Workflow {
  readonly concurrency?: { readonly "cancel-in-progress"?: unknown };
  readonly jobs: Record<string, Job>;
}
const workflow = (name: string) => parse(read(`.github/workflows/${name}.yml`)) as Workflow;
const WORKFLOW_FILES = [
  ".github/workflows/ci.yml",
  ".github/workflows/pi-compat.yml",
  ".github/actions/setup/action.yml",
];

describe("CI configuration", () => {
  it("runs on every pull request and every push to main, docs-only changes included (M13-C12)", () => {
    const on = (parse(read(".github/workflows/ci.yml")) as { on: Record<string, Record<string, unknown>> })
      .on;
    expect(Object.keys(on).toSorted()).toEqual(["pull_request", "push"]);
    expect(on["push"]).toEqual({ branches: ["main"] });
    expect(on["pull_request"] ?? null).toBeNull();
  });

  it("runs knip as a step that can fail the build (R5)", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toMatch(/^\s+- run: pnpm knip$/m);
    expect(ci).not.toContain("continue-on-error");
  });

  it("makes ripgrep, fd (named fd) and procps available to every job, before the install (R92)", () => {
    const setup = read(".github/actions/setup/action.yml");
    for (const needle of ["ripgrep", "fd-find", "procps", 'ln -s "$(command -v fdfind)" /usr/local/bin/fd']) {
      expect(setup, needle).toContain(needle);
    }
    expect(setup.indexOf("fd-find")).toBeLessThan(setup.indexOf("run: pnpm install"));
  });

  it("uses Playwright only as an exact dev dependency behind test:e2e (ADR 0071 reverses R128)", () => {
    const manifest = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(manifest.scripts["test:e2e"]).toBe(
      "node --disable-warning=ExperimentalWarning scripts/e2e/run.ts",
    );
    expect(manifest.devDependencies["@playwright/test"]).toBe("1.63.0");
    expect(read("knip.json")).toContain("scripts/e2e");
  });

  it("gives every job a timeout: 15 minutes, 20 for the integration tests and the nightly run (R63)", () => {
    const ci = workflow("ci").jobs;
    expect(
      Object.fromEntries(Object.entries(ci).map(([name, job]) => [name, job["timeout-minutes"]])),
    ).toMatchObject({ checks: 15, unit: 15, integration: 20, build: 15 });
    // The budgets (B1) and e2e (A5) jobs pin their own value in ci-config.budgets.test.ts and ci-config.e2e.test.ts.
    for (const [name, job] of Object.entries(ci)) {
      expect(job["timeout-minutes"], name).toBeGreaterThanOrEqual(1);
      expect(job["timeout-minutes"], name).toBeLessThanOrEqual(30);
    }
    expect(Object.values(workflow("pi-compat").jobs).map((job) => job["timeout-minutes"])).toEqual([20]);
  });

  it("pins every action outside this repository by commit SHA, with the version in a comment (R63)", () => {
    const uses = WORKFLOW_FILES.flatMap((file) =>
      [...read(file).matchAll(/^\s*(?:- )?uses:\s*(\S+)(?:\s+#\s*(\S+))?\s*$/gm)].map(([, ref, comment]) => ({
        file,
        ref,
        comment,
      })),
    ).filter(({ ref }) => !ref?.startsWith("./"));
    expect(uses.length).toBeGreaterThan(5);
    for (const { file, ref, comment } of uses) {
      expect(ref, `${file}: ${ref}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      expect(comment, `${file}: ${ref}`).toMatch(/^v\d+$/);
    }
    expect(uses.some(({ ref }) => ref?.startsWith("pnpm/action-setup@"))).toBe(true);
  });

  it("cancels a superseded run for pull requests only (R63)", () => {
    expect(workflow("ci").concurrency?.["cancel-in-progress"]).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
  });

  it("checks out without leaving the token in the git config (R63)", () => {
    const checkouts = ["ci", "pi-compat"].flatMap((name) =>
      Object.values(workflow(name).jobs).flatMap((job) =>
        job.steps.filter((step) => step.uses?.startsWith("actions/checkout@")),
      ),
    );
    expect(checkouts.length).toBeGreaterThanOrEqual(6);
    for (const step of checkouts) expect(step.with?.["persist-credentials"]).toBe(false);
  });

  it("type-checks the nightly run after the bump and before its unit and integration tests, on a runner with the probe tools (R63, R92)", () => {
    const steps = Object.values(workflow("pi-compat").jobs)[0]?.steps ?? [];
    const order = [
      "scripts/pi-compat-bump.ts",
      "pnpm install --no-frozen-lockfile",
      "pnpm typecheck",
      "pnpm test:unit",
      "pnpm test:int",
    ].map((command) => steps.findIndex((step) => step.run?.includes(command)));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(steps.find((step) => step.uses === "./.github/actions/setup")?.with).toEqual({
      install: "false",
      sandbox: "true",
    });
  });

  it("builds @pap/contracts before the root typecheck, which resolves it through dist (checks and nightly)", () => {
    const jobs = [workflow("ci").jobs["checks"], Object.values(workflow("pi-compat").jobs)[0]];
    for (const job of jobs) {
      const steps = job?.steps ?? [];
      const build = steps.findIndex((step) => step.run === "pnpm --filter @pap/contracts build");
      const typecheck = steps.findIndex((step) => step.run === "pnpm typecheck");
      expect(build).toBeGreaterThanOrEqual(0);
      expect(build).toBeLessThan(typecheck);
    }
  });

  it("smoke-tests the built artifacts right after the build, before the artifact is uploaded", () => {
    const steps = workflow("ci").jobs["build"]?.steps ?? [];
    const order = [
      steps.findIndex((step) => step.run === "pnpm build"),
      steps.findIndex((step) => step.run === "pnpm smoke"),
      steps.findIndex((step) => step.uses?.startsWith("actions/upload-artifact@")),
    ];
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
    expect(scripts["smoke"]).toBe("node --disable-warning=ExperimentalWarning scripts/smoke-dist.ts");
  });

  it("checks the bundle budget on the built artifact", () => {
    const { jobs } = workflow("ci");
    expect(Object.keys(jobs)).toEqual(
      expect.arrayContaining(["checks", "unit", "integration", "build", "budgets"]),
    );
    const budgets = jobs["budgets"];
    expect(budgets?.needs).toBe("build");
    const download = budgets?.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
    expect(download?.with).toEqual({ name: "dist", path: "." });
  });
});

describe("agent sandbox prerequisites (M13-C9)", () => {
  it.each([
    ["ci integration", () => workflow("ci").jobs["integration"], { sandbox: "true" }],
    ["pi-compat", () => Object.values(workflow("pi-compat").jobs)[0], { install: "false", sandbox: "true" }],
  ])("asks the setup action for bubblewrap in the %s job (it runs test:int)", (_name, job, inputs) => {
    const setup = job()?.steps.find((step) => step.uses === "./.github/actions/setup");
    expect(setup?.with).toEqual(inputs);
  });

  it("the setup action installs bubblewrap and lifts the userns limit", () => {
    const action = read(".github/actions/setup/action.yml");
    expect(action).toContain("bubblewrap");
    expect(action).toContain("sysctl -w kernel.apparmor_restrict_unprivileged_userns=0");
    expect(action).toMatch(/if: inputs\.sandbox == 'true'/);
  });
});

describe("inherited descriptors (M13-C13)", () => {
  it("runs test:int through the wrapper that closes every descriptor above 2, in both jobs", () => {
    for (const job of [workflow("ci").jobs["integration"], Object.values(workflow("pi-compat").jobs)[0]]) {
      const run = job?.steps.find((step) => step.run?.includes("pnpm test:int"))?.run;
      expect(run?.trim()).toBe("scripts/ci/without-inherited-fds.sh pnpm test:int");
    }
    const wrapper = read("scripts/ci/without-inherited-fds.sh");
    expect(wrapper).toContain("GitHub's Actions runner");
    expect(wrapper).toContain("bash -c");
    expect(wrapper).toContain('eval "exec $fd>&-"');
    expect(statSync(resolve(import.meta.dirname, "ci/without-inherited-fds.sh")).mode & 0o111).not.toBe(0);
  });
});

describe("systemd user manager (owner M2-Q8)", () => {
  it("starts a lingering systemd user manager before the integration tests", () => {
    const jobs = [workflow("ci").jobs["integration"], Object.values(workflow("pi-compat").jobs)[0]];
    for (const job of jobs) {
      const steps = job?.steps ?? [];
      const linger = steps.findIndex((step) => step.run?.includes("loginctl enable-linger"));
      const tests = steps.findIndex((step) => step.run?.includes("pnpm test:int"));
      expect(linger).toBeGreaterThanOrEqual(0);
      expect(linger).toBeLessThan(tests);
    }
  });
});

describe("root typecheck (R25)", () => {
  it("covers scripts and the root config files with strict, noEmit options", () => {
    const root = JSON.parse(read("tsconfig.json")) as {
      extends: string;
      compilerOptions: Record<string, unknown>;
      include: string[];
    };
    expect(root.extends).toBe("./tsconfig.base.json");
    expect(root.compilerOptions).toEqual({ noEmit: true });
    expect(root.include).toEqual(["scripts/**/*.ts", "*.config.ts"]);
    const base = JSON.parse(read("tsconfig.base.json")) as { compilerOptions: { strict: boolean } };
    expect(base.compilerOptions.strict).toBe(true);
  });

  it("runs as part of pnpm typecheck", () => {
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
    expect(scripts["typecheck"]).toBe("pnpm -r --parallel run typecheck && tsc -p tsconfig.json");
  });
});
