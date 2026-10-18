import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PACKAGES = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
] as const;

type Times = Record<string, Record<string, string>>;

const CATALOG_ENTRY = /^([ \t]+"@earendil-works\/[^"]+":[ \t]*)[^\s#]+([ \t]+#.*)?$/gm;
const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export function catalogEntryCount(yaml: string): number {
  return [...yaml.matchAll(CATALOG_ENTRY)].length;
}

export function bumpCatalog(yaml: string, version: string): string {
  if (!RELEASE.test(version)) throw new Error(`pi-compat-bump: version must be X.Y.Z, got ${version}`);
  return yaml.replace(CATALOG_ENTRY, `$1${version}$2`);
}

export function readMinimumReleaseAge(yaml: string): number {
  const match = /^minimumReleaseAge:[ \t]*(\d+)/m.exec(yaml);
  if (match?.[1] === undefined)
    throw new Error("pi-compat-bump: no minimumReleaseAge in pnpm-workspace.yaml");
  return Number(match[1]);
}

function publishedAt(times: Times, version: string): number | null {
  let latest = -Infinity;
  for (const name of PACKAGES) {
    const raw = times[name]?.[version];
    const ms = raw === undefined ? NaN : Date.parse(raw);
    if (Number.isNaN(ms)) return null;
    latest = Math.max(latest, ms);
  }
  return latest;
}

function compare(a: string, b: string): number {
  const left = RELEASE.exec(a) ?? [];
  const right = RELEASE.exec(b) ?? [];
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(left[i]) - Number(right[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

// The newest X.Y.Z that all three packages publish, with no pre-release, whose latest publish is old enough.
export function pickNewest(times: Times, nowMs: number, minAgeMinutes: number): string | null {
  const candidates = Object.keys(times[PACKAGES[0]] ?? {}).filter((version) => RELEASE.test(version));
  const eligible = candidates.filter((version) => {
    const published = publishedAt(times, version);
    return published !== null && published + minAgeMinutes * MINUTE_MS <= nowMs;
  });
  return eligible.sort(compare).at(-1) ?? null;
}

export async function fetchTimes(): Promise<Times> {
  const times: Times = {};
  for (const name of PACKAGES) {
    const response = await fetch(`https://registry.npmjs.org/${name}`);
    if (!response.ok) throw new Error(`registry answered ${response.status} for ${name}`);
    const body = (await response.json()) as { time?: Record<string, string> };
    times[name] = body.time ?? {};
  }
  return times;
}

export interface Pick {
  readonly version: string;
  readonly published: string;
  readonly days: number;
}

// Fetches first, so offline it fails before anything is written or created.
export async function choose(
  yaml: string,
  nowMs: number,
  fetchImpl: () => Promise<Times> = fetchTimes,
): Promise<Pick> {
  if (catalogEntryCount(yaml) === 0) throw new Error("no @earendil-works catalog line found");
  const minAge = readMinimumReleaseAge(yaml);
  const times = await fetchImpl();
  const version = pickNewest(times, nowMs, minAge);
  if (version === null) {
    throw new Error(`no release of the three Pi packages is at least ${minAge} minutes old`);
  }
  const published = publishedAt(times, version) ?? nowMs;
  return {
    version,
    published: new Date(published).toISOString(),
    days: Math.floor((nowMs - published) / DAY_MS),
  };
}

export const describePick = (pick: Pick): string =>
  `pi-compat: testing ${pick.version} (published ${pick.published}, ${pick.days} days old)`;

export interface MainOptions {
  readonly path: string;
  readonly nowMs: number;
  readonly fetchTimes: () => Promise<Times>;
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

export async function main(options: MainOptions): Promise<number> {
  const before = readFileSync(options.path, "utf8");
  try {
    const pick = await choose(before, options.nowMs, options.fetchTimes);
    writeFileSync(options.path, bumpCatalog(before, pick.version));
    options.log(describePick(pick));
    return 0;
  } catch (error) {
    options.error(
      `pi-compat-bump: ${error instanceof Error ? error.message : String(error)} (${options.path})`,
    );
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main({
    path: "pnpm-workspace.yaml",
    nowMs: Date.now(),
    fetchTimes,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  });
}
