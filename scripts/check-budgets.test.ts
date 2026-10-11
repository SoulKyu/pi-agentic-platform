import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialAssets, initialBundleGzipKb } from "./check-budgets.ts";

let dist: string;
beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), "pap-budget-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(
    join(dist, "index.html"),
    '<script type="module" crossorigin src="/assets/index-a1.js"></script><link rel="modulepreload" crossorigin href="/assets/vendor-b2.js"><link rel="stylesheet" crossorigin href="/assets/index-c3.css">',
  );
  writeFileSync(join(dist, "assets/index-a1.js"), "console.log(1);".repeat(100));
  writeFileSync(join(dist, "assets/vendor-b2.js"), "export const v = 1;".repeat(100));
  writeFileSync(join(dist, "assets/index-c3.css"), "body{color:red}".repeat(100));
  writeFileSync(join(dist, "assets/lazy-d4.js"), "x".repeat(500_000));
});
afterEach(() => rmSync(dist, { recursive: true, force: true }));

describe("bundle budget", () => {
  it("counts only the scripts, preloads and styles index.html loads first", () => {
    const html =
      '<script type="module" src="/assets/index-a1.js"></script><link rel="modulepreload" href="/assets/vendor-b2.js">';
    expect(initialAssets(html)).toEqual(["/assets/index-a1.js", "/assets/vendor-b2.js"]);
    const kb = initialBundleGzipKb(dist);
    expect(kb).toBeGreaterThan(0);
    expect(kb).toBeLessThan(5);
  });

  describe("command line", () => {
    const script = resolve(import.meta.dirname, "check-budgets.ts");
    const run = (budgetKb: number) => {
      const project = mkdtempSync(join(tmpdir(), "pap-budget-cwd-"));
      try {
        mkdirSync(join(project, "apps/web"), { recursive: true });
        writeFileSync(join(project, "budgets.json"), JSON.stringify({ initialBundleGzipKb: budgetKb }));
        cpSync(dist, join(project, "apps/web/dist"), { recursive: true });
        return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", script], {
          cwd: project,
          encoding: "utf8",
        });
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    };

    it("passes under the budget and says which budgets it does not measure", () => {
      const result = run(180);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/initial bundle: [\d.]+ KB gzip \(budget 180 KB\)/);
      expect(result.stdout).toContain("session open payload: not measured in M1");
      expect(result.stdout).toContain("idle worker RSS: not measured in M1");
    });

    it("fails over the budget", () => {
      expect(run(0.001).status).toBe(1);
    });
  });
});
