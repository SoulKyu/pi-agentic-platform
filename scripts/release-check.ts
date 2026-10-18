import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";
import { checkShrinkwrap } from "./release-check-shrinkwrap.ts";

const VERSION = /^\d+\.\d+\.\d+$/;
const PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/;
const WORKFLOW = ".github/workflows/release.yml";
const ALLOWED_TRIGGER = "workflow_dispatch";
const JOB_PERMISSIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  stable: { contents: "write", "pull-requests": "write", issues: "write" },
  next: { contents: "write" },
};
/** Expressions whose value an attacker or a typo controls must reach a script through `env:`, never inside `run:`. */
const RUN_INJECTION = /\$\{\{[^}]*\b(?:github\.event|github\.head_ref|inputs)\b/;
const MAIN_GUARD = "github.ref == 'refs/heads/main'";

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

const workflow = (root: string, problems: string[]): void => {
  const text = readText(root, WORKFLOW);
  const doc = record(parse(text));
  for (const trigger of triggers(doc.on))
    if (trigger !== ALLOWED_TRIGGER)
      problems.push(`${WORKFLOW}: trigger "${trigger}" is not allowed before the v1 flip`);
  if (!isDeepStrictEqual(doc.permissions, { contents: "read" }))
    problems.push(`${WORKFLOW}: top-level permissions must be exactly contents: read`);
  for (const [name, job] of Object.entries(record(doc.jobs))) {
    const condition = record(job).if;
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

/** Every problem found under `root`; an empty list means the release setup is consistent. */
export function checkRelease(root: string): string[] {
  const problems: string[] = [];
  const checks: [string, (root: string, problems: string[]) => void][] = [
    ["package.json, apps/daemon/package.json, .release-please-manifest.json", versions],
    ["release-please-config.json", config],
    [WORKFLOW, workflow],
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
