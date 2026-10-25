import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkEnforcers, ENFORCERS } from "./check-budgets.ts";

const root = resolve(import.meta.dirname, "..");
const real = (path: string) => readFileSync(resolve(root, path), "utf8");
const budgetsJson = JSON.parse(real("budgets.json")) as Record<string, number>;

const everyKey = Object.keys(ENFORCERS);
const complete = Object.fromEntries(everyKey.map((key) => [key, 1]));
const known = new Set(Object.values(ENFORCERS).flat() as string[]);
const allKeys = everyKey.join(" ");
/** A reader that serves every enforcer file with `text(path)` and fails on any other path. */
const serve =
  (text: (path: string) => string = () => allKeys) =>
  (path: string) => {
    if (!known.has(path)) throw new Error(`ENOENT ${path}`);
    return text(path);
  };
const without = (key: string, replacement = "") => allKeys.replace(key, replacement);

describe("budget enforcers", () => {
  it("accepts the real budgets.json against the real files", () => {
    expect(checkEnforcers(budgetsJson, real)).toEqual([]);
  });

  it("pins the final values: a drift is a deliberate edit (owner q4, M13R10)", () => {
    expect(budgetsJson).toEqual({
      initialBundleGzipKb: 300,
      serviceWorkerGzipKb: 5,
      sessionOpenPayloadKb: 24,
      idleWorkerRssMb: 200,
      searchP95Ms: 200,
      scannerLatencyMs: 2500,
    });
  });

  it("accepts a stub where every enforcer names its key", () => {
    expect(checkEnforcers(complete, serve())).toEqual([]);
  });

  it("reports a key that has no enforcer", () => {
    const problems = checkEnforcers({ ...complete, unenforcedKey: 3 }, serve());
    expect(problems).toEqual([expect.stringMatching(/unenforcedKey.*no enforcer/)]);
  });

  it("reports a missing key", () => {
    const withoutSearch: Record<string, number> = { ...complete };
    delete withoutSearch["searchP95Ms"];
    expect(checkEnforcers(withoutSearch, serve())).toEqual([expect.stringContaining("searchP95Ms")]);
  });

  it("reports an enforcer file that does not exist", () => {
    const problems = checkEnforcers(complete, (path) => {
      if (path.endsWith("search.budget.int.test.ts")) throw new Error("ENOENT");
      return serve()(path);
    });
    expect(problems).toEqual([expect.stringContaining("search.budget.int.test.ts")]);
  });

  it("reports a file whose text does not contain the key as a whole word", () => {
    const problems = checkEnforcers(
      complete,
      serve(() => without("idleWorkerRssMb", "idleWorkerRssMbExtra")),
    );
    expect(problems.length).toBeGreaterThan(0);
    for (const problem of problems) expect(problem).toContain("idleWorkerRssMb");
  });

  it.each([
    ["a property read", "budgets.scannerLatencyMs"],
    ["a call argument", 'budgetKb("budgets.json", "scannerLatencyMs")'],
    ["a destructuring", "const { scannerLatencyMs } = budgets;"],
  ])("accepts the key named as %s", (_label, text) => {
    expect(
      checkEnforcers(
        complete,
        serve(() => `${without("scannerLatencyMs")} ${text}`),
      ),
    ).toEqual([]);
  });
});
