import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const BUDGET_TEST = "apps/daemon/src/modules/sessions/sessions.budgets.int.test.ts";
const SEARCH_TEST = "apps/daemon/src/modules/search/search.budget.int.test.ts";
const SCANNER_TEST = "apps/daemon/src/modules/search/scanner.exit.int.test.ts";

/** Budget key to the files that assert it. Each file must name the key (checked by `checkEnforcers`). */
export const ENFORCERS = {
  initialBundleGzipKb: ["scripts/check-budgets.ts", "apps/web/src/build-output.int.test.ts"],
  serviceWorkerGzipKb: ["scripts/check-budgets.ts", "apps/web/src/build-output.pwa.int.test.ts"],
  sessionOpenPayloadKb: [BUDGET_TEST, "apps/daemon/src/daemon.int.test.ts"],
  idleWorkerRssMb: [BUDGET_TEST, "apps/daemon/src/daemon.int.test.ts"],
  searchP95Ms: [SEARCH_TEST],
  scannerLatencyMs: [SCANNER_TEST],
} as const satisfies Record<string, readonly string[]>;

export type BudgetKey = keyof typeof ENFORCERS;

/** Problems: a key with no enforcer, an extra or missing key, a missing enforcer file, a file that does not name the key. */
export function checkEnforcers(json: unknown, readFile: (path: string) => string): string[] {
  const problems: string[] = [];
  const keys = Object.keys((json ?? {}) as Record<string, unknown>);
  const enforced: Record<string, readonly string[]> = ENFORCERS;
  for (const key of keys) {
    if ((enforced[key] ?? []).length === 0)
      problems.push(`budgets.json: ${key} has no enforcer in ENFORCERS`);
  }
  for (const [key, files] of Object.entries(enforced)) {
    if (!keys.includes(key)) problems.push(`budgets.json: ${key} is missing (ENFORCERS names it)`);
    for (const file of files) {
      let text: string;
      try {
        text = readFile(file);
      } catch {
        problems.push(`${key}: enforcer ${file} cannot be read`);
        continue;
      }
      if (!new RegExp(`\\b${key}\\b`).test(text)) problems.push(`${key}: enforcer ${file} does not name it`);
    }
  }
  return problems;
}

export function initialAssets(indexHtml: string): string[] {
  const assets = new Set<string>();
  for (const match of indexHtml.matchAll(
    /<(?:script|link)\b[^>]*\b(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g,
  )) {
    if (match[1]) assets.add(match[1]);
  }
  return [...assets];
}

export function initialBundleGzipBytes(distDir: string): number {
  const html = readFileSync(join(distDir, "index.html"), "utf8");
  const assets = initialAssets(html);
  if (assets.length === 0) {
    throw new Error(
      `${join(distDir, "index.html")} loads no script or stylesheet from /assets/: nothing to measure`,
    );
  }
  const bytes = assets.reduce(
    (sum, asset) => sum + gzipSync(readFileSync(join(distDir, asset)), { level: 9 }).length,
    0,
  );
  return bytes;
}

const toKb = (bytes: number): number => Math.round((bytes / 1024) * 10) / 10;

export function initialBundleGzipKb(distDir: string): number {
  return toKb(initialBundleGzipBytes(distDir));
}

/** Compared unrounded: 4.04 KB must not pass a 4 KB line because it displays as 4. */
export function overBudget(bytes: number, budgetKb: number): boolean {
  return bytes > budgetKb * 1024;
}

export function lazyAssets(distDir: string): Array<{ file: string; gzipKb: number }> {
  const initial = new Set(initialAssets(readFileSync(join(distDir, "index.html"), "utf8")));
  return readdirSync(join(distDir, "assets"))
    .filter((name) => /\.(?:js|css)$/.test(name))
    .map((name) => `/assets/${name}`)
    .filter((file) => !initial.has(file))
    .sort()
    .map((file) => ({
      file,
      gzipKb: Math.round((gzipSync(readFileSync(join(distDir, file)), { level: 9 }).length / 1024) * 10) / 10,
    }));
}

export function serviceWorkerGzipBytes(distDir: string): number {
  return gzipSync(readFileSync(join(distDir, "sw.js")), { level: 9 }).length;
}

export function serviceWorkerGzipKb(distDir: string): number {
  return toKb(serviceWorkerGzipBytes(distDir));
}

function budgetKb(path: string, key: "initialBundleGzipKb" | "serviceWorkerGzipKb"): number {
  const budget = (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)[key];
  if (typeof budget !== "number" || !Number.isFinite(budget)) {
    throw new Error(`${path}: ${key} must be a number, found ${JSON.stringify(budget) ?? "nothing"}`);
  }
  return budget;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const real = JSON.parse(readFileSync(join(root, "budgets.json"), "utf8")) as unknown;
    const problems = checkEnforcers(real, (path) => readFileSync(join(root, path), "utf8"));
    if (problems.length > 0) throw new Error(`budget enforcers:\n  ${problems.join("\n  ")}`);
    for (const [key, files] of Object.entries(ENFORCERS)) console.log(`enforced ${key}: ${files.join(", ")}`);
    const budget = budgetKb("budgets.json", "initialBundleGzipKb");
    const measuredBytes = initialBundleGzipBytes("apps/web/dist");
    const measured = toKb(measuredBytes);
    console.log(`initial bundle: ${measured} KB gzip (budget ${budget} KB)`);
    const swBudget = budgetKb("budgets.json", "serviceWorkerGzipKb");
    const swBytes = serviceWorkerGzipBytes("apps/web/dist");
    const swMeasured = toKb(swBytes);
    console.log(`service worker: ${swMeasured} KB gzip (budget ${swBudget} KB)`);
    for (const { file, gzipKb } of lazyAssets("apps/web/dist"))
      console.log(`lazy ${file}: ${gzipKb} KB gzip`);
    console.log(`session open payload: measured by ${BUDGET_TEST} (pnpm test:int)`);
    console.log(`idle worker RSS: measured by ${BUDGET_TEST} (pnpm test:int)`);
    console.log(`search p95: measured by ${SEARCH_TEST} (pnpm test:budget)`);
    console.log(`scanner latency: measured by ${SCANNER_TEST} (pnpm test:budget)`);
    if (overBudget(measuredBytes, budget) || overBudget(swBytes, swBudget)) process.exitCode = 1;
  } catch (error) {
    console.error(`check-budgets: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
