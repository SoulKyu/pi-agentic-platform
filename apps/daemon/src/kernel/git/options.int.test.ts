import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitBed, type GitBed } from "../testing/git-bed.ts";
import { gitArgs, gitEnv } from "./exec.ts";

let bed: GitBed;
let root: string;
beforeEach(() => {
  bed = createGitBed();
  root = bed.root;
});
afterEach(() => bed.dispose());

/** The runner's flags and environment without its option check: the second line, in front of real git. */
const direct = (args: string[]): void => {
  try {
    execFileSync("git", gitArgs(root, args), {
      env: gitEnv({ PATH: process.env.PATH, HOME: bed.home }, root),
      stdio: "ignore",
    });
  } catch {
    // The verdict does not matter, only whether the plant ran.
  }
};

describe("every planned caller's argv runs on real git (MC18)", () => {
  it("starts git for each argv (an exit code of 128 or 1 still means git ran)", async () => {
    const head = bed.git(root, "rev-parse", "HEAD").trim();
    const planned: string[][] = [
      ["status", "--porcelain=v2", "-z", "--branch", "--ignore-submodules=dirty"],
      ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "HEAD", "--"],
      ["ls-files", "-z", "--cached", "--", "a.txt"],
      // m15: a dash-led name is passed as ./-name
      ["ls-files", "-z", "--cached", "--", "./-rf"],
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      ["cat-file", "blob", "HEAD:a.txt"],
      ["cat-file", "blob", ":a.txt"],
      ["cat-file", "blob", `${head}:a.txt`],
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "--abbrev-ref", "HEAD"],
      // MC15: the runner drops --literal-pathspecs for check-ignore, which exits 128 under it.
      ["check-ignore", "-z", "--stdin", "--no-index"],
    ];
    for (const args of planned) {
      const out = await bed.runner().run(root, args, { okCodes: [0, 1, 128], timeoutMs: 5000 });
      expect(out.code, args.join(" ")).toBeLessThanOrEqual(128);
    }
    const checked = await bed.runner().run(root, planned.at(-1) ?? [], { okCodes: [0, 1], timeoutMs: 5000 });
    expect(checked.code).toBe(1);
    const dash = await bed.runner().run(root, ["ls-files", "-z", "--cached", "--", "./-rf"]);
    expect(dash.stdout.toString("utf8")).toBe("-rf\0");
    const status = await bed.runner().run(root, planned[0] ?? [], { timeoutMs: 5000 });
    expect(status.stdout.toString("utf8")).toContain("# branch.head main");
    const blob = await bed.runner().run(root, ["cat-file", "blob", "HEAD:a.txt"]);
    expect(blob.stdout.toString("utf8")).toBe("one\n");
  });
});

describe("remerge diffs and merge drivers (I1)", () => {
  function mergeCommitWithDriver(): { marker: string } {
    const { script, marker } = bed.plant("merge");
    writeFileSync(join(root, ".gitattributes"), "m.txt merge=evil\n");
    writeFileSync(join(root, "m.txt"), "base\n");
    bed.git(root, "add", ".");
    bed.git(root, "commit", "-q", "-m", "base");
    bed.git(root, "checkout", "-q", "-b", "side");
    writeFileSync(join(root, "m.txt"), "side\n");
    bed.git(root, "commit", "-q", "-am", "side");
    bed.git(root, "checkout", "-q", "main");
    writeFileSync(join(root, "m.txt"), "main\n");
    bed.git(root, "commit", "-q", "-am", "main");
    bed.git(root, "config", "merge.evil.driver", `${script} %O %A %B`);
    bed.git(root, "merge", "-q", "side", "-m", "merge");
    rmSync(marker, { force: true });
    return { marker };
  }

  it("log.diffMerges=remerge and -m never reach the driver through the runner's flags", async () => {
    const { marker } = mergeCommitWithDriver();
    bed.git(root, "config", "log.diffMerges", "remerge");
    bed.git(root, "log", "-m", "-p", "-1");
    expect(existsSync(marker), "control: plain git remerges through the driver").toBe(true);
    rmSync(marker);
    direct(["log", "-m", "-p", "-1"]);
    direct(["show", "-m", "HEAD"]);
    expect(existsSync(marker)).toBe(false);
    await bed.runner().run(root, ["log"]);
    await bed.runner().run(root, ["show", "HEAD"]);
    expect(existsSync(marker)).toBe(false);
  });

  it("--remerge-diff is refused before git starts", async () => {
    const { marker } = mergeCommitWithDriver();
    bed.git(root, "log", "--remerge-diff", "-1");
    expect(existsSync(marker), "control: plain git runs the driver").toBe(true);
    rmSync(marker);
    for (const args of [
      ["log", "--remerge-diff", "-1"],
      ["show", "--remerge-diff", "HEAD"],
      ["log", "--diff-merges=r", "-p"],
    ]) {
      await expect(bed.runner().run(root, args)).rejects.toMatchObject({ kind: "failed" });
    }
    expect(existsSync(marker)).toBe(false);
  });
});

describe("--alternate-refs (I2)", () => {
  it("core.alternateRefsCommand is blank behind the option check, and the option is refused", async () => {
    const { script, marker } = bed.plant("alternates");
    const other = join(bed.dir, "other");
    bed.initRepo(other);
    mkdirSync(join(root, ".git", "objects", "info"), { recursive: true });
    writeFileSync(join(root, ".git", "objects", "info", "alternates"), `${join(other, ".git", "objects")}\n`);
    bed.git(root, "config", "core.alternateRefsCommand", script);
    bed.git(root, "log", "--alternate-refs", "--oneline", "-1");
    expect(existsSync(marker), "control").toBe(true);
    rmSync(marker);
    direct(["log", "--alternate-refs", "--oneline", "-1"]);
    direct(["diff", "HEAD", "--alternate-refs"]);
    expect(existsSync(marker)).toBe(false);
    await expect(bed.runner().run(root, ["log", "--alternate-refs"])).rejects.toMatchObject({
      kind: "failed",
    });
    await bed.runner().run(root, ["log"]);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("status -v (I3)", () => {
  it("is refused, and the planned status run is silent", async () => {
    const { script, marker } = bed.plant("statusv");
    writeFileSync(join(root, ".gitattributes"), "*.txt diff=evil\n");
    bed.git(root, "config", "diff.evil.textconv", script);
    writeFileSync(join(root, "a.txt"), "two\n");
    bed.git(root, "add", "a.txt");
    bed.git(root, "status", "-v");
    expect(existsSync(marker), "control: status -v runs the textconv").toBe(true);
    rmSync(marker);
    for (const flag of ["-v", "-vv", "--verbose", "-bv"]) {
      await expect(bed.runner().run(root, ["status", flag])).rejects.toMatchObject({ kind: "failed" });
    }
    await bed.runner().run(root, ["status", "--porcelain=v2", "-z", "--branch", "--ignore-submodules=dirty"]);
    expect(existsSync(marker)).toBe(false);
  });
});
