import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listByProject, listProblems, planRun, resolveCoreDir, type PlanInput } from "./run.ts";

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  localBrowsers: { chromium: true, webkit: true },
  podman: true,
  playwrightVersion: "1.63.0",
  coreDir: "/core/playwright-core",
  wsPort: 41234,
  extraArgs: [],
  missingDist: [],
  ...over,
});

describe("planRun", () => {
  it("runs locally when both browsers are installed", () => {
    const plan = planRun(input());
    expect(plan.mode).toBe("local");
    expect(plan.start).toBeUndefined();
    expect(plan.env).toEqual({});
    expect(plan.testArgs).toEqual(["test", "-c", "scripts/e2e/playwright.config.ts"]);
  });

  it("starts the pinned container when a local browser is missing and podman exists (M13R2, R38)", () => {
    for (const localBrowsers of [
      { chromium: false, webkit: true },
      { chromium: true, webkit: false },
      { chromium: false, webkit: false },
    ]) {
      const plan = planRun(input({ localBrowsers }));
      expect(plan.mode).toBe("container");
      expect(plan.image).toBe("mcr.microsoft.com/playwright:v1.63.0-noble");
      expect(plan.start).toEqual([
        "run",
        "-d",
        "--rm",
        "--network",
        "host",
        "--ipc=host",
        "--name",
        "pap-e2e-41234",
        "-v",
        "/core/playwright-core:/pw:ro,Z",
        "mcr.microsoft.com/playwright:v1.63.0-noble",
        "node",
        "/pw/cli.js",
        "run-server",
        "--host",
        "127.0.0.1",
        "--port",
        "41234",
      ]);
      expect(plan.env).toEqual({ PAP_E2E_WS: "ws://127.0.0.1:41234/" });
    }
  });

  it("stops with a pointer to the guide when there is no browser and no podman", () => {
    const plan = planRun(input({ localBrowsers: { chromium: false, webkit: false }, podman: false }));
    expect(plan.mode).toBe("none");
    expect(plan.message).toContain("docs/agents/e2e.md");
  });

  it("honours a forced mode and refuses it when it cannot run", () => {
    expect(planRun(input({ forced: "container", podman: false })).mode).toBe("none");
    expect(planRun(input({ forced: "local", localBrowsers: { chromium: true, webkit: false } })).mode).toBe(
      "none",
    );
    expect(planRun(input({ forced: "container" })).mode).toBe("container");
    expect(planRun(input({ forced: "local" })).mode).toBe("local");
    expect(planRun(input({ forced: "container", podman: false })).message).toContain("docs/agents/e2e.md");
  });

  it("refuses to run without the built daemon and web app", () => {
    const plan = planRun(input({ missingDist: ["apps/daemon/dist", "apps/web/dist"] }));
    expect(plan.mode).toBe("none");
    expect(plan.message).toContain("apps/daemon/dist");
    expect(plan.message).toContain("apps/web/dist");
    expect(plan.message).toContain("pnpm build");
  });

  it("derives the image tag from the installed version and puts the extra arguments last", () => {
    const plan = planRun(
      input({
        localBrowsers: { chromium: false, webkit: false },
        playwrightVersion: "1.64.0",
        extraArgs: ["j01", "--headed"],
      }),
    );
    expect(plan.image).toBe("mcr.microsoft.com/playwright:v1.64.0-noble");
    expect(plan.start).toContain("mcr.microsoft.com/playwright:v1.64.0-noble");
    expect(plan.testArgs.slice(-2)).toEqual(["j01", "--headed"]);
  });

  it("uses an endpoint given by the environment without starting a container", () => {
    const plan = planRun(
      input({ wsEndpoint: "ws://127.0.0.1:9999/", localBrowsers: { chromium: false, webkit: false } }),
    );
    expect(plan.start).toBeUndefined();
    expect(plan.env).toEqual({ PAP_E2E_WS: "ws://127.0.0.1:9999/" });
  });
});

describe("resolveCoreDir (M13R38)", () => {
  it("finds playwright-core through @playwright/test, under pnpm's strict layout", () => {
    expect(existsSync(join(resolveCoreDir(), "cli.js"))).toBe(true);
  });
});

describe("listProblems (Review Focus 2: no silent zero)", () => {
  const files = ["j01-setup.e2e.ts", "j06-mobile.e2e.ts"];
  const whole = {
    chromium: ["j01-setup.e2e.ts"],
    webkit: ["j01-setup.e2e.ts"],
    "chromium-phone": ["j06-mobile.e2e.ts"],
    "webkit-phone": ["j06-mobile.e2e.ts"],
  };

  it("accepts the routing of the config", () => {
    expect(listProblems(whole, files, false)).toEqual([]);
  });

  it("fails on an empty list", () => {
    expect(listProblems({}, files, true)).toEqual([expect.stringContaining("no test")]);
  });

  it("names a project that lost its tests, but only for a whole-suite run", () => {
    const lost = { ...whole, webkit: [] };
    expect(listProblems(lost, files, false)).toEqual([expect.stringContaining("webkit")]);
    expect(listProblems(lost, files, true)).toEqual([]);
  });

  it("expects the phone projects only once a j06 journey exists", () => {
    const early = { chromium: ["j01-setup.e2e.ts"], webkit: ["j01-setup.e2e.ts"] };
    expect(listProblems(early, ["j01-setup.e2e.ts"], false)).toEqual([]);
    expect(listProblems(early, files, false)).toHaveLength(2);
  });

  it("flags a j06 journey on a desktop project and a desktop journey on a phone project (M13R40)", () => {
    const wrong = { ...whole, chromium: ["j06-mobile.e2e.ts"], "webkit-phone": ["j01-setup.e2e.ts"] };
    const problems = listProblems(wrong, files, false);
    expect(problems.join("\n")).toMatch(/chromium.*j06/s);
    expect(problems.join("\n")).toMatch(/webkit-phone.*j01/s);
  });
});

describe("listByProject", () => {
  it("collects the spec files of each project from a json report", () => {
    const report = {
      suites: [
        {
          file: "a.e2e.ts",
          specs: [],
          suites: [
            {
              file: "a.e2e.ts",
              specs: [{ file: "a.e2e.ts", tests: [{ projectName: "chromium" }, { projectName: "webkit" }] }],
            },
          ],
        },
        { file: "b.e2e.ts", specs: [{ file: "b.e2e.ts", tests: [{ projectName: "chromium" }] }] },
      ],
    };
    expect(listByProject(report)).toEqual({ chromium: ["a.e2e.ts", "b.e2e.ts"], webkit: ["a.e2e.ts"] });
  });
});

describe("the real list (starts no browser)", () => {
  const dir = join(import.meta.dirname);
  it("routes every journey to the right projects (M13R40)", () => {
    const out = execFileSync(
      process.execPath,
      [
        join(import.meta.dirname, "..", "..", "node_modules", "@playwright", "test", "cli.js"),
        "test",
        "-c",
        join(dir, "playwright.config.ts"),
        "--list",
        "--reporter=json",
      ],
      { cwd: join(dir, "..", ".."), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    const byProject = listByProject(JSON.parse(out));
    const onDisk = readdirSync(dir).filter((name) => name.endsWith(".e2e.ts"));
    expect(Object.keys(byProject).length).toBeGreaterThan(0);
    expect(byProject["chromium"]?.length).toBeGreaterThan(0);
    expect(byProject["webkit"]?.length).toBeGreaterThan(0);
    expect(listProblems(byProject, onDisk, false)).toEqual([]);
  }, 60_000);
});
