import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialAssets, initialBundleGzipKb, lazyAssets } from "./check-budgets.ts";

const INDEX_HTML =
  '<script type="module" crossorigin src="/assets/index-a1.js"></script><link rel="modulepreload" crossorigin href="/assets/vendor-b2.js"><link rel="stylesheet" crossorigin href="/assets/index-c3.css">';
const INITIAL = ["/assets/index-a1.js", "/assets/vendor-b2.js", "/assets/index-c3.css"];

// Incompressible content, so that every file moves the measured size by about its own size and counting
// the lazy chunk or dropping the stylesheet cannot hide behind a few bytes of gzip.
let dist: string;
beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), "pap-budget-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), INDEX_HTML);
  writeFileSync(join(dist, "assets/index-a1.js"), randomBytes(6_000));
  writeFileSync(join(dist, "assets/vendor-b2.js"), randomBytes(3_000));
  writeFileSync(join(dist, "assets/index-c3.css"), randomBytes(1_500));
  writeFileSync(join(dist, "assets/lazy-d4.js"), randomBytes(500_000));
});
afterEach(() => rmSync(dist, { recursive: true, force: true }));

const gzipBytes = (asset: string) => gzipSync(readFileSync(join(dist, asset)), { level: 9 }).length;

describe("bundle budget", () => {
  it("lists the scripts, preloads and styles index.html loads first, in order, and not the lazy chunk", () => {
    expect(initialAssets(INDEX_HTML)).toEqual(INITIAL);
    expect(initialAssets(`${INDEX_HTML}<link rel="icon" href="/favicon.svg">`)).toEqual(INITIAL);
  });

  it("sums the gzip size of exactly those files", () => {
    const expectedBytes = INITIAL.reduce((sum, asset) => sum + gzipBytes(asset), 0);
    expect(initialBundleGzipKb(dist)).toBe(Math.round((expectedBytes / 1024) * 10) / 10);
    expect(gzipBytes("/assets/lazy-d4.js")).toBeGreaterThan(expectedBytes * 10);
  });

  it("lists every other asset as lazy, with its gzip size", () => {
    const lazyKb = Math.round((gzipBytes("/assets/lazy-d4.js") / 1024) * 10) / 10;
    expect(lazyAssets(dist)).toEqual([{ file: "/assets/lazy-d4.js", gzipKb: lazyKb }]);
  });

  it("throws when index.html loads no script or stylesheet, instead of passing on nothing", () => {
    writeFileSync(join(dist, "index.html"), "<p>no bundle</p>");
    expect(() => initialBundleGzipKb(dist)).toThrow(/loads no script or stylesheet/);
  });

  describe("command line", () => {
    const script = resolve(import.meta.dirname, "check-budgets.ts");
    const run = (budgets: unknown) => {
      const project = mkdtempSync(join(tmpdir(), "pap-budget-cwd-"));
      try {
        mkdirSync(join(project, "apps/web"), { recursive: true });
        writeFileSync(join(project, "budgets.json"), JSON.stringify(budgets));
        cpSync(dist, join(project, "apps/web/dist"), { recursive: true });
        return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", script], {
          cwd: project,
          encoding: "utf8",
        });
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    };

    it("passes under the budget and names the test that measures the other two budgets", () => {
      const result = run({ initialBundleGzipKb: 180 });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/initial bundle: [\d.]+ KB gzip \(budget 180 KB\)/);
      expect(result.stdout).toContain(
        "session open payload: measured by apps/daemon/src/modules/sessions/sessions.budgets.int.test.ts",
      );
      expect(result.stdout).toContain(
        "idle worker RSS: measured by apps/daemon/src/modules/sessions/sessions.budgets.int.test.ts",
      );
    });

    it("prints each lazy chunk", () => {
      const result = run({ initialBundleGzipKb: 180 });
      expect(result.stdout).toMatch(/^lazy \/assets\/lazy-d4\.js: [\d.]+ KB gzip$/m);
    });

    it("fails over the budget and prints the budget it failed", () => {
      const result = run({ initialBundleGzipKb: 0.001 });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("budget 0.001 KB");
    });

    it.each([
      { label: "a string", budgets: { initialBundleGzipKb: "180" } },
      { label: "missing", budgets: { sessionOpenPayloadKb: 64 } },
      { label: "null", budgets: { initialBundleGzipKb: null } },
    ])("fails with a message when the budget is $label, never passing vacuously", ({ budgets }) => {
      const result = run(budgets);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("initialBundleGzipKb");
      expect(result.stdout).not.toContain("initial bundle:");
    });

    it("fails with a message when index.html loads nothing to measure", () => {
      writeFileSync(join(dist, "index.html"), "<p>no bundle</p>");
      const result = run({ initialBundleGzipKb: 180 });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("loads no script or stylesheet");
    });
  });
});
