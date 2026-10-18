import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";
import { checkShrinkwrap } from "./release-check-shrinkwrap.ts";

const VERSION = /^\d+\.\d+\.\d+$/;
const PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/;
const WORKFLOW = ".github/workflows/release.yml";
const PI_COMPAT = ".github/workflows/pi-compat.yml";
const DISPATCH = "workflow_dispatch";
/** The nightly pi-compat schedule the v1 flip restores (it ran at this time before M13R33 made the workflow dispatch-only). */
export const PI_COMPAT_CRON = "17 3 * * *";
const JOB_PERMISSIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  stable: { contents: "write", "pull-requests": "write", issues: "write" },
  next: { contents: "write" },
};
/** Expressions whose value an attacker or a typo controls must reach a script through `env:`, never inside `run:`. */
const RUN_INJECTION = /\$\{\{[^}]*\b(?:github\.event|github\.head_ref|inputs)\b/;
const MAIN_GUARD = "github.ref == 'refs/heads/main'";
const SETUP_ACTION = "./.github/actions/setup";

/** The `if:` of each release job before and after the v1 flip (ADR 0066 as amended by ADR 0076); `next` never changes. */
export const JOB_CONDITIONS = {
  before: {
    stable: `${MAIN_GUARD} && inputs.channel == 'stable'`,
    next: `${MAIN_GUARD} && inputs.channel == 'next'`,
  },
  after: {
    stable: `${MAIN_GUARD} && (github.event_name == 'push' || inputs.channel == 'stable')`,
    next: `${MAIN_GUARD} && inputs.channel == 'next'`,
  },
} as const;

/** The project licence ids the release accepts once a `LICENSE` file exists (owner q14, M13R57). */
export const AGPL_IDS: readonly string[] = ["AGPL-3.0-only", "AGPL-3.0-or-later"];
const UNLICENSED = "UNLICENSED";
const AFFERO_TITLE = /^\s*GNU AFFERO GENERAL PUBLIC LICENSE\s*$/;
const APACHE_FILE = "LICENSES/Apache-2.0.txt";

export const EXPECTED_CONFIG = {
  $schema: "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "release-type": "node",
  "bump-minor-pre-major": true,
  "bump-patch-for-minor-pre-major": false,
  "include-component-in-tag": false,
  packages: {
    ".": {
      "package-name": "pap",
      "changelog-path": "CHANGELOG.md",
      "extra-files": [{ type: "json", path: "apps/daemon/package.json", jsonpath: "$.version" }],
    },
  },
};

/** The release tag of a version: `v` + x.y.z. */
export const releaseTag = (version: string): string => {
  if (!VERSION.test(version)) throw new Error(`version ${version} is not x.y.z`);
  return `v${version}`;
};

const readText = (root: string, file: string): string => readFileSync(join(root, file), "utf8");
const readJson = (root: string, file: string): unknown => JSON.parse(readText(root, file));
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const versions = (root: string, problems: string[]): void => {
  const sources: [string, unknown][] = [
    ["package.json", record(readJson(root, "package.json")).version],
    ["apps/daemon/package.json", record(readJson(root, "apps/daemon/package.json")).version],
    [".release-please-manifest.json", record(readJson(root, ".release-please-manifest.json"))["."]],
  ];
  for (const [file, version] of sources)
    if (typeof version !== "string" || !VERSION.test(version))
      problems.push(`${file}: version is missing or not x.y.z`);
  const rootVersion = sources[0]?.[1];
  if (typeof rootVersion === "string" && VERSION.test(rootVersion)) releaseTag(rootVersion);
  for (const [file, version] of sources.slice(1))
    if (version !== rootVersion)
      problems.push(`${file}: version ${String(version)} differs from package.json ${String(rootVersion)}`);
};

const config = (root: string, problems: string[]): void => {
  if (!isDeepStrictEqual(readJson(root, "release-please-config.json"), EXPECTED_CONFIG))
    problems.push("release-please-config.json: differs from the pinned configuration");
};

const triggers = (on: unknown): string[] =>
  typeof on === "string" ? [on] : Array.isArray(on) ? on.map(String) : Object.keys(record(on));

/** `on:` is exactly `workflow_dispatch` (before the flip) or `push: {branches: [main]}` plus `workflow_dispatch` (after). Returns whether it is flipped. */
const trigger = (on: unknown, problems: string[]): boolean => {
  const names = triggers(on);
  const flipped = names.includes("push");
  for (const name of names)
    if (name !== DISPATCH && !(flipped && name === "push"))
      problems.push(
        `${WORKFLOW}: trigger "${name}" is not allowed (only ${DISPATCH}, and push of main after the v1 flip)`,
      );
  if (flipped) {
    if (!names.includes(DISPATCH)) problems.push(`${WORKFLOW}: trigger push needs ${DISPATCH} next to it`);
    if (!isDeepStrictEqual(record(on).push, { branches: ["main"] }))
      problems.push(`${WORKFLOW}: trigger push must be exactly branches: [main]`);
  }
  return flipped;
};

const conditionShape = (name: string, condition: unknown, flipped: boolean, problems: string[]): void => {
  const table = JOB_CONDITIONS[flipped ? "after" : "before"];
  const wanted = name === "stable" || name === "next" ? table[name] : undefined;
  if (wanted !== undefined && condition !== wanted)
    problems.push(
      `${WORKFLOW}: job ${name} if must be exactly "${wanted}" ${flipped ? "after" : "before"} the v1 flip`,
    );
};

/** A job that holds a write token restores no pnpm cache: a poisoned cache would run with that token (ADR 0066 item 4). */
const cacheRule = (name: string, job: Record<string, unknown>, problems: string[]): void => {
  if (record(job.permissions).contents !== "write") return;
  const steps = Array.isArray(job.steps) ? (job.steps as unknown[]) : [];
  const setups = steps.map(record).filter((step) => step.uses === SETUP_ACTION);
  if (setups.length === 0 || setups.some((step) => record(step.with).cache !== "false"))
    problems.push(
      `${WORKFLOW}: job ${name} holds contents: write, so its setup step must pass cache: "false"`,
    );
};

const workflow = (root: string, problems: string[]): void => {
  const text = readText(root, WORKFLOW);
  const doc = record(parse(text));
  const flipped = trigger(doc.on, problems);
  if (!isDeepStrictEqual(doc.permissions, { contents: "read" }))
    problems.push(`${WORKFLOW}: top-level permissions must be exactly contents: read`);
  for (const [name, job] of Object.entries(record(doc.jobs))) {
    const condition = record(job).if;
    conditionShape(name, condition, flipped, problems);
    cacheRule(name, record(job), problems);
    if (typeof condition !== "string" || !condition.startsWith(`${MAIN_GUARD} && `))
      problems.push(`${WORKFLOW}: job ${name} must run only on main: if starts with ${MAIN_GUARD} &&`);
    if (name === "next" && typeof record(record(job).concurrency).group !== "string")
      problems.push(`${WORKFLOW}: job next needs a concurrency group`);
    const wanted = JOB_PERMISSIONS[name];
    if (wanted === undefined || !isDeepStrictEqual(record(job).permissions, wanted))
      problems.push(`${WORKFLOW}: job ${name} permissions must be exactly ${JSON.stringify(wanted ?? {})}`);
    const steps = Array.isArray(record(job).steps) ? (record(job).steps as unknown[]) : [];
    for (const step of steps) {
      const { uses, with: inputs, run } = record(step);
      if (typeof run === "string" && RUN_INJECTION.test(run))
        problems.push(
          `${WORKFLOW}: job ${name} has an expression of github.event, github.head_ref or inputs inside run: (pass it through env:)`,
        );
      if (typeof uses !== "string" || uses.startsWith("./")) continue;
      if (!PINNED.test(uses))
        problems.push(`${WORKFLOW}: job ${name} uses ${uses}, not pinned by a 40-hex commit`);
      if (uses.startsWith("actions/checkout@") && record(inputs)["persist-credentials"] !== false)
        problems.push(`${WORKFLOW}: job ${name} checkout must set persist-credentials: false`);
    }
  }
  for (const match of text.matchAll(/secrets\.([A-Za-z0-9_]+)/g))
    if (match[1] !== "GITHUB_TOKEN")
      problems.push(`${WORKFLOW}: references secrets.${match[1]}; only GITHUB_TOKEN is allowed`);
  // Index and whole-object forms: secrets['X'], toJSON(secrets), ${{ secrets }}
  if (/\bsecrets\b(?!\.[A-Za-z0-9_])/.test(text))
    problems.push(`${WORKFLOW}: references secrets other than by name; only secrets.GITHUB_TOKEN is allowed`);
};

const licenseId = (root: string, file: string): string => {
  const value = record(readJson(root, file)).license;
  return typeof value === "string" ? value : UNLICENSED;
};

const licence = (root: string, problems: string[]): void => {
  const id = licenseId(root, "package.json");
  const daemon = licenseId(root, "apps/daemon/package.json");
  const hasFile = existsSync(join(root, "LICENSE"));
  if (daemon !== id)
    problems.push(`apps/daemon/package.json: license ${daemon} differs from package.json ${id}`);
  if (id === UNLICENSED) {
    if (hasFile)
      problems.push("LICENSE: the file exists but package.json license is UNLICENSED (or missing)");
    return;
  }
  if (!AGPL_IDS.includes(id)) {
    problems.push(
      `package.json: license ${id} is not one of ${AGPL_IDS.join(", ")} (or UNLICENSED with no LICENSE file)`,
    );
    return;
  }
  if (!hasFile) problems.push(`LICENSE: missing, package.json license is ${id}`);
  else if (
    !AFFERO_TITLE.test(
      readText(root, "LICENSE")
        .split("\n")
        .find((line) => line.trim() !== "") ?? "",
    )
  )
    problems.push("LICENSE: the title line is not GNU AFFERO GENERAL PUBLIC LICENSE");
  if (!existsSync(join(root, APACHE_FILE)))
    problems.push(`${APACHE_FILE}: missing (the derived ai-elements file needs it)`);
  const notices = existsSync(join(root, "THIRD_PARTY_NOTICES.md"))
    ? readText(root, "THIRD_PARTY_NOTICES.md")
    : "";
  if (!notices.includes(APACHE_FILE)) problems.push(`THIRD_PARTY_NOTICES.md: does not name ${APACHE_FILE}`);
};

/** pi-compat.yml `on:` is exactly `workflow_dispatch` while release.yml is not flipped, and the nightly `schedule` plus `workflow_dispatch` once it is. */
const piCompat = (root: string, problems: string[]): void => {
  const flipped = triggers(record(parse(readText(root, WORKFLOW))).on).includes("push");
  const on = record(parse(readText(root, PI_COMPAT))).on;
  const wanted = flipped ? { schedule: [{ cron: PI_COMPAT_CRON }], [DISPATCH]: null } : { [DISPATCH]: null };
  const normalized = Object.fromEntries(
    Object.entries(record(on)).map(([name, value]) => [name, name === DISPATCH ? null : value]),
  );
  if (!isDeepStrictEqual(normalized, wanted))
    problems.push(
      `${PI_COMPAT}: on: must be exactly ${flipped ? `schedule cron "${PI_COMPAT_CRON}" plus ${DISPATCH} after` : `${DISPATCH} before`} the v1 flip (found ${triggers(on).join(", ") || "nothing"})`,
    );
};

/** Every problem found under `root`; an empty list means the release setup is consistent. */
export function checkRelease(root: string): string[] {
  const problems: string[] = [];
  const checks: [string, (root: string, problems: string[]) => void][] = [
    ["package.json, apps/daemon/package.json, .release-please-manifest.json", versions],
    ["release-please-config.json", config],
    [WORKFLOW, workflow],
    [`${PI_COMPAT} and ${WORKFLOW}`, piCompat],
    ["package.json, apps/daemon/package.json, LICENSE", licence],
    [".pap-npm/package/npm-shrinkwrap.json", checkShrinkwrap],
  ];
  for (const [files, check] of checks) {
    try {
      check(root, problems);
    } catch (error: unknown) {
      problems.push(`${files}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkRelease(resolve(import.meta.dirname, ".."));
  for (const problem of problems) console.error(`release-check: ${problem}`);
  if (problems.length > 0) process.exitCode = 1;
  else console.log("release-check: ok");
}
