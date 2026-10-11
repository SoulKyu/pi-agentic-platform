import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

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
  const bytes = initialAssets(html).reduce(
    (sum, asset) => sum + gzipSync(readFileSync(join(distDir, asset)), { level: 9 }).length,
    0,
  );
  return Math.round((bytes / 1024) * 10) / 10;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const budgets = JSON.parse(readFileSync("budgets.json", "utf8")) as { initialBundleGzipKb: number };
  const measured = initialBundleGzipKb("apps/web/dist");
  console.log(`initial bundle: ${measured} KB gzip (budget ${budgets.initialBundleGzipKb} KB)`);
  console.log("session open payload: not measured in M1");
  console.log("idle worker RSS: not measured in M1");
  if (measured > budgets.initialBundleGzipKb) process.exitCode = 1;
}
