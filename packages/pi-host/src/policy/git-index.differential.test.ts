import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GIT_SUBMODULES, gitGuard, repoConfigRefusal } from "./git-config-guard.ts";
import { GIT_ENV, lsFiles } from "./git-index.fixtures.ts";
import { fuzzCase, realBases } from "./git-index.fuzz.ts";

/**
 * M7 ruling MC11 (b): the guard against the real `git` binary. Every seed builds one index (real or built, then
 * mutated) in a real repository. Wherever the guard reads the index, git must read it too, without and with the
 * threaded load, and both must agree on whether it records a gitlink: the guard clean means git lists no 160000 entry.
 * Where the guard asks, git is not run (some of those indexes make it abort).
 */

const SEED = 20_261_013;
const CASES = 1500;
/**
 * Seeds that broke the property against the reader of round 3 (MC11), replayed by the same oracle whatever `SEED` and
 * `CASES` become. Each class also has hand-built rows in git-index.extensions.test.ts.
 */
const REGRESSION_SEEDS: readonly number[] = [
  // git's threaded load read entries the reader had not walked (NEW-3): a gitlink, or bytes git died on.
  20261033, 20261034, 20261037, 20261043, 20261044, 20261059, 20261088, 20261112, 20261117, 20261120,
  20261123, 20261168, 20261177, 20261184, 20261202, 20261203, 20261224, 20261226, 20261232, 20261237,
  20261241, 20261260, 20261263, 20261264, 20261270, 20261277, 20261281, 20261284, 20261318, 20261336,
  20261343, 20261373, 20261400, 20261410, 20261421, 20261423, 20261427, 20261432, 20261436, 20261447,
  20261461, 20261466, 20261467, 20261477, 20261517, 20261534, 20261550, 20261554, 20261567, 20261581,
  20261587, 20261593, 20261621, 20261627, 20261630, 20261632, 20261634, 20261685, 20261708, 20261731,
  20261732, 20261734, 20261735, 20261750, 20261759, 20261768, 20261793, 20261805, 20261823, 20261839,
  20261862, 20261874, 20261878, 20261883, 20261984, 20262003, 20262007, 20262018, 20262029, 20262047,
  20262073, 20262081, 20262082, 20262090, 20262117, 20262141, 20262146, 20262155, 20262210, 20262251,
  20262274, 20262295, 20262296, 20262299, 20262343, 20262397, 20262407, 20262411, 20262414, 20262424,
  20262433, 20262438, 20262459,
  // git died on an unknown lowercase or garbled extension name.
  20261142, 20261149, 20261154, 20261216, 20261348, 20261369, 20261393, 20261536, 20261583, 20261681,
  20261706, 20262028, 20262060, 20262134, 20262332, 20262354, 20262492,
  // git died on unknown extended flags.
  20261214, 20262026, 20262045, 20262151, 20262244, 20262261,
  // git aborted on an fsmonitor bitmap longer than the index.
  20261458,
];

let root: string;
let home: string;
let top: string;
let bases: Buffer[];
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-git-index-diff-")));
  home = join(root, "home");
  top = join(root, "repo");
  for (const folder of [home, top, join(root, "bases")]) mkdirSync(folder);
  bases = realBases(join(root, "bases"), home);
  execFileSync("git", ["init", "-q"], { cwd: top, env: GIT_ENV(home), stdio: "pipe" });
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

type Outcome = "clean" | "gitlink" | "asks";

/** The guard's answer for one seed's index and, where it reads the index, how git's reading disagrees (or null). */
async function judge(seed: number): Promise<{ readonly outcome: Outcome; readonly broken: string | null }> {
  writeFileSync(join(top, ".git", "index"), fuzzCase(seed, bases));
  const why = await repoConfigRefusal(top, gitGuard(home));
  const outcome: Outcome = why === null ? "clean" : why === GIT_SUBMODULES ? "gitlink" : "asks";
  if (outcome === "asks") return { outcome, broken: null };
  for (const threads of [false, true]) {
    const git = lsFiles(top, home, threads);
    if (!git.ok || (outcome === "clean") !== (git.gitlinks === 0)) {
      const stderr = git.stderr.trim().slice(0, 80);
      return {
        outcome,
        broken: `seed ${seed}: guard ${outcome}, git threads=${threads} ok=${git.ok} gitlinks=${git.gitlinks} ${stderr}`,
      };
    }
  }
  return { outcome, broken: null };
}

describe("the index reader against real git (MC11)", () => {
  it(`agrees with git on ${CASES} seeded indexes`, { timeout: 60_000 }, async () => {
    const counts: Record<Outcome, number> = { clean: 0, gitlink: 0, asks: 0 };
    const broken: string[] = [];
    for (let seed = SEED; seed < SEED + CASES; seed++) {
      const result = await judge(seed);
      counts[result.outcome]++;
      if (result.broken !== null) broken.push(result.broken);
    }
    expect(broken).toEqual([]);
    // Bounds, not exact counts: the real bases are written by the local git, whose layout may vary by version.
    expect(counts.clean).toBeGreaterThanOrEqual(150);
    expect(counts.gitlink).toBeGreaterThanOrEqual(150);
    expect(counts.asks).toBeGreaterThanOrEqual(CASES / 3);
  });

  it.each(REGRESSION_SEEDS)("seed %i, which once broke it, holds", async (seed) => {
    expect((await judge(seed)).broken).toBeNull();
  });
});
