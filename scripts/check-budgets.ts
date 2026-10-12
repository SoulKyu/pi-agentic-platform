import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const BUDGET_TEST = "apps/daemon/src/modules/sessions/sessions.budgets.int.test.ts";

export function initialAssets(indexHtml: string): string[] {
  const assets = new Set<string>();
  for (const match of indexHtml.matchAll(
    /<(?:script|link)\b[^>]*\b(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g,
  )) {
    if (match[1]) assets.add(match[1]);
  }
  return [...assets];
}

export function initialBundleGzipKb(distDir: string): number {
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
  return Math.round((bytes / 1024) * 10) / 10;
}

function initialBundleBudgetKb(path: string): number {
  const budget = (JSON.parse(readFileSync(path, "utf8")) as { initialBundleGzipKb?: unknown })
    .initialBundleGzipKb;
  if (typeof budget !== "number" || !Number.isFinite(budget)) {
    throw new Error(
      `${path}: initialBundleGzipKb must be a number, found ${JSON.stringify(budget) ?? "nothing"}`,
    );
  }
  return budget;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const budget = initialBundleBudgetKb("budgets.json");
    const measured = initialBundleGzipKb("apps/web/dist");
    console.log(`initial bundle: ${measured} KB gzip (budget ${budget} KB)`);
    console.log(`session open payload: measured by ${BUDGET_TEST} (pnpm test:int)`);
    console.log(`idle worker RSS: measured by ${BUDGET_TEST} (pnpm test:int)`);
    if (measured > budget) process.exitCode = 1;
  } catch (error) {
    console.error(`check-budgets: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
