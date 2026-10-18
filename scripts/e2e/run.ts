// `pnpm test:e2e`: runs the Playwright journeys of scripts/e2e against the built daemon and web app (M13R2).
//   local      chromium and webkit are installed on this machine;
//   container  otherwise, with podman: a pinned Playwright image serves the browsers (`run-server`, host network), the
//              tests and the daemons stay on this machine; the image tag follows the installed Playwright version;
//   PAP_E2E_MODE=local|container forces one; PAP_E2E_WS=ws://... uses a browser server that is already running.
// Nothing here runs in a unit test except `planRun`, `resolveCoreDir`, `listByProject` and `listProblems`.
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { connect } from "node:net";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { missingDist } from "../build-archive-stage.ts";
import { freePort, REPO } from "../smoke-lib.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = "scripts/e2e/playwright.config.ts";
const GUIDE = "docs/agents/e2e.md";
// A constant, not a literal in each call: knip would list `podman` as an unlisted binary (it is an optional host tool).
const CONTAINER_ENGINE = "podman";
const PORT_WAIT_MS = 30_000;
const DESKTOP = ["chromium", "webkit"] as const;
const PHONE = ["chromium-phone", "webkit-phone"] as const;
const isPhoneJourney = (file: string): boolean => /(^|[\\/])j06-/.test(file);

export interface PlanInput {
  forced?: string;
  localBrowsers: { chromium: boolean; webkit: boolean };
  podman: boolean;
  playwrightVersion: string;
  coreDir: string;
  wsPort: number;
  extraArgs: string[];
  missingDist: string[];
  /** A browser server that already runs (PAP_E2E_WS): used as it is, there is no container of ours to manage. */
  wsEndpoint?: string;
}
export interface RunPlan {
  mode: "local" | "container" | "none";
  image?: string;
  start?: string[];
  testArgs: string[];
  env: Record<string, string>;
  message?: string;
}

const none = (message: string, testArgs: string[]): RunPlan => ({ mode: "none", testArgs, env: {}, message });

export function planRun(input: PlanInput): RunPlan {
  const testArgs = ["test", "-c", CONFIG, ...input.extraArgs];
  if (input.missingDist.length > 0)
    return none(
      `${input.missingDist.join(" and ")} missing: the daemon under test is the built one, run pnpm build first (${GUIDE})`,
      testArgs,
    );
  if (input.wsEndpoint !== undefined)
    return { mode: "local", testArgs, env: { PAP_E2E_WS: input.wsEndpoint } };
  const local = input.localBrowsers.chromium && input.localBrowsers.webkit;
  const wanted = input.forced ?? (local ? "local" : input.podman ? "container" : "none");
  if (wanted === "local") {
    if (local) return { mode: "local", testArgs, env: {} };
    return none(
      `PAP_E2E_MODE=local needs the chromium and webkit executables of Playwright: see ${GUIDE}`,
      testArgs,
    );
  }
  if (wanted === "container") {
    if (!input.podman) return none(`PAP_E2E_MODE=container needs podman: see ${GUIDE}`, testArgs);
    const image = `mcr.microsoft.com/playwright:v${input.playwrightVersion}-noble`;
    const port = String(input.wsPort);
    return {
      mode: "container",
      image,
      // --ipc=host: Chromium's 64 MB /dev/shm default crashes heavy pages.
      start: [
        ...["run", "-d", "--rm", "--network", "host", "--ipc=host", "--name", containerName(input.wsPort)],
        ...["-v", `${input.coreDir}:/pw:ro,Z`, image],
        ...["node", "/pw/cli.js", "run-server", "--host", "127.0.0.1", "--port", port],
      ],
      testArgs,
      env: { PAP_E2E_WS: `ws://127.0.0.1:${port}/` },
    };
  }
  return none(`no browser and no podman: see ${GUIDE}`, testArgs);
}

const containerName = (port: number): string => `pap-e2e-${port}`;

/** playwright-core is transitive under pnpm's strict layout: it resolves through @playwright/test (M13R38). */
export function resolveCoreDir(): string {
  const fromHere = createRequire(import.meta.url);
  const viaTest = createRequire(fromHere.resolve("@playwright/test/package.json"));
  return dirname(viaTest.resolve("playwright-core/package.json"));
}

interface ListedSpec {
  file?: string;
  tests?: { projectName?: string }[];
}
interface ListedSuite {
  specs?: ListedSpec[];
  suites?: ListedSuite[];
}

/** `playwright test --list --reporter=json` as project name -> spec files (one entry per test). */
export function listByProject(report: unknown): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  const walk = (suite: ListedSuite): void => {
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests ?? []) {
        const name = test.projectName ?? "";
        const files = (found[name] ??= []);
        if (spec.file !== undefined && !files.includes(spec.file)) files.push(spec.file);
      }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of (report as { suites?: ListedSuite[] }).suites ?? []) walk(suite);
  return found;
}

/**
 * What would make a run silently wrong: nothing listed, a journey on a project the config does not route it to
 * (M13R40), or, for a whole-suite run, a project that holds no tests although files exist for it.
 */
export function listProblems(
  byProject: Record<string, string[]>,
  onDisk: string[],
  filtered: boolean,
): string[] {
  const problems: string[] = [];
  if (Object.values(byProject).every((files) => files.length === 0)) problems.push("the list holds no test");
  for (const name of DESKTOP)
    if (byProject[name]?.some(isPhoneJourney))
      problems.push(`${name} lists a j06 journey: the phone projects own those`);
  for (const name of PHONE) {
    const stray = byProject[name]?.find((file) => !isPhoneJourney(file));
    if (stray !== undefined) problems.push(`${name} lists ${stray}, which is not a j06 journey`);
  }
  if (filtered) return problems;
  for (const name of [...DESKTOP, ...PHONE]) {
    const phone = (PHONE as readonly string[]).includes(name);
    const expected = onDisk.some((file) => isPhoneJourney(file) === phone);
    if (expected && (byProject[name]?.length ?? 0) === 0) problems.push(`${name} lists no test`);
  }
  return problems;
}

/** Only a non-flag argument (a file or a title filter) narrows the run: `--headed` or `--reporter=line` do not. */
export const isFiltered = (args: string[]): boolean => args.some((arg) => !arg.startsWith("-"));

const onPort = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });

async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + PORT_WAIT_MS;
  while (Date.now() < deadline) {
    if (await onPort(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the browser server did not listen on ${port} within ${PORT_WAIT_MS / 1000} s`);
}

const hasExecutable = (path: string): boolean => {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
};

async function main(): Promise<number> {
  const extraArgs = process.argv.slice(2);
  const forced = process.env["PAP_E2E_MODE"];
  if (forced !== undefined && forced !== "local" && forced !== "container") {
    console.error(`PAP_E2E_MODE is "${forced}": use local or container (${GUIDE})`);
    return 1;
  }
  const { chromium, webkit } = await import("@playwright/test");
  const playwrightVersion = (
    createRequire(import.meta.url)("@playwright/test/package.json") as { version: string }
  ).version;
  const wsEndpoint = process.env["PAP_E2E_WS"] || undefined;
  const wsPort = await freePort();
  const plan = planRun({
    ...(forced ? { forced } : {}),
    ...(wsEndpoint ? { wsEndpoint } : {}),
    localBrowsers: {
      chromium: hasExecutable(chromium.executablePath()),
      webkit: hasExecutable(webkit.executablePath()),
    },
    podman: spawnSync(CONTAINER_ENGINE, ["--version"], { stdio: "ignore" }).status === 0,
    playwrightVersion,
    coreDir: resolveCoreDir(),
    wsPort,
    extraArgs,
    missingDist: missingDist(REPO),
  });
  if (plan.mode === "none") {
    console.error(`test:e2e: ${plan.message}`);
    return 1;
  }
  const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
  const playwright = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: REPO,
      env: { ...process.env, ...env },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });

  // Review Focus 2: the list is read before anything starts, so an empty or misrouted suite never "passes".
  const listing = playwright(["test", "-c", CONFIG, "--list", "--reporter=json", ...extraArgs]);
  if (listing.status !== 0) {
    console.error(`test:e2e: playwright could not list the tests\n${listing.stderr || listing.stdout}`);
    return 1;
  }
  const byProject = listByProject(JSON.parse(listing.stdout));
  const onDisk = readdirSync(HERE).filter((name) => name.endsWith(".e2e.ts"));
  const problems = listProblems(byProject, onDisk, isFiltered(extraArgs));
  if (problems.length > 0) {
    console.error(`test:e2e: ${problems.join("; ")}`);
    return 1;
  }
  console.log(
    `test:e2e: ${Object.entries(byProject)
      .map(([name, files]) => `${name} ${files.length} file(s)`)
      .join(", ")}`,
  );

  const name = plan.start ? containerName(wsPort) : undefined;
  const cleanup = (): void => {
    if (name) spawnSync(CONTAINER_ENGINE, ["rm", "-f", name], { stdio: "ignore" });
  };
  let child: ChildProcess | undefined;
  const forward = (signal: NodeJS.Signals) => () => {
    child?.kill(signal);
    cleanup();
    process.exit(128 + (signal === "SIGINT" ? 2 : 15));
  };
  process.once("SIGINT", forward("SIGINT"));
  process.once("SIGTERM", forward("SIGTERM"));
  try {
    if (plan.start) {
      console.log(`test:e2e: browsers from ${plan.image} (container ${name})`);
      execFileSync(CONTAINER_ENGINE, plan.start, { stdio: ["ignore", "ignore", "inherit"] });
      await waitForPort(wsPort);
    }
    for (const type of [chromium, webkit]) {
      const browser = plan.env["PAP_E2E_WS"]
        ? await type.connect(plan.env["PAP_E2E_WS"])
        : await type.launch();
      console.log(`test:e2e: ${type.name()} ${browser.version()}`);
      await browser.close();
    }
    child = spawn(process.execPath, [cli, ...plan.testArgs], {
      cwd: REPO,
      env: { ...process.env, ...plan.env },
      stdio: "inherit",
    });
    return await new Promise<number>((resolve) =>
      child?.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 0))),
    );
  } finally {
    cleanup();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`test:e2e: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
