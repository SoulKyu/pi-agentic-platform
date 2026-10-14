import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitBed, type GitBed } from "../testing/git-bed.ts";
import { guardFilters } from "./filters.ts";

// MC13 with real git: a repository's own filter drivers do not run for status and diff, and the call still answers.
let bed: GitBed;
beforeEach(() => {
  bed = createGitBed();
});
afterEach(() => bed.dispose());

const STATUS = ["status", "--porcelain=v2", "-z", "--branch", "--ignore-submodules=dirty"];
const DIFF = [
  "diff",
  "--numstat",
  "-z",
  "--ignore-submodules=dirty",
  "--no-ext-diff",
  "--no-textconv",
  "HEAD",
  "--",
];
const guarded = (base: NodeJS.ProcessEnv = {}) => guardFilters(bed.runner(base));
const changed = () => writeFileSync(join(bed.root, "a.txt"), "two\n");
const attribute = (name: string) => writeFileSync(join(bed.root, ".gitattributes"), `*.txt filter=${name}\n`);

describe("a repository's filter drivers (MC13)", () => {
  it.each([["clean"], ["process"]])("does not run its %s program", async (kind) => {
    const { script, marker } = bed.plant("evil");
    attribute("evil");
    bed.git(bed.root, "config", `filter.evil.${kind}`, script);
    bed.git(bed.root, "config", "filter.evil.required", "true");
    changed();
    // A `required` driver that fails makes plain git fail too: the marker is the control, not the exit code.
    try {
      bed.git(bed.root, "status", "--porcelain");
    } catch {
      // expected for a driver that does not speak the process protocol
    }
    expect(existsSync(marker), "control: plain git runs the driver").toBe(true);
    rmSync(marker);
    const status = await guarded().run(bed.root, STATUS);
    expect(status.stdout.toString("utf8")).toContain("a.txt");
    const diff = await guarded().run(bed.root, DIFF);
    expect(diff.stdout.toString("utf8")).toBe("1\t1\ta.txt\0");
    expect(existsSync(marker)).toBe(false);
  });

  it("empties a driver whose name has dots and an equals sign", async () => {
    const { script, marker } = bed.plant("odd");
    writeFileSync(join(bed.root, ".gitattributes"), "*.txt filter=a=b.c\n");
    bed.git(bed.root, "config", "filter.a=b.c.clean", script);
    changed();
    bed.git(bed.root, "status", "--porcelain");
    expect(existsSync(marker), "control: plain git runs the driver").toBe(true);
    rmSync(marker);
    await guarded().run(bed.root, STATUS);
    expect(existsSync(marker)).toBe(false);
  });

  it("empties a driver that an included file defines", async () => {
    const { script, marker } = bed.plant("inc");
    attribute("inc");
    writeFileSync(join(bed.root, ".git", "extra.cfg"), `[filter "inc"]\n\tclean = ${script}\n`);
    bed.git(bed.root, "config", "include.path", "extra.cfg");
    changed();
    bed.git(bed.root, "status", "--porcelain");
    expect(existsSync(marker), "control: plain git runs the driver").toBe(true);
    rmSync(marker);
    await guarded().run(bed.root, STATUS);
    expect(existsSync(marker)).toBe(false);
  });

  it("leaves the owner's own global driver alone (his config, as in M7's guard)", async () => {
    const { script, marker } = bed.plant("mine");
    attribute("mine");
    writeFileSync(join(bed.home, ".gitconfig"), `[filter "mine"]\n\tclean = ${script}\n`);
    changed();
    await guarded().run(bed.root, STATUS);
    expect(existsSync(marker)).toBe(true);
  });

  it("leaves the standard git-lfs entries, and empties a driver called lfs that is not standard", async () => {
    const binDir = join(bed.dir, "bin");
    mkdirSync(binDir);
    const lfsMarker = join(bed.dir, "lfs.marker");
    const lfs = join(binDir, "git-lfs");
    writeFileSync(lfs, `#!/bin/sh\necho ran > '${lfsMarker}'\ncat\n`);
    chmodSync(lfs, 0o755);
    const PATH = `${binDir}:${process.env.PATH ?? ""}`;
    attribute("lfs");
    bed.git(bed.root, "config", "filter.lfs.clean", "git-lfs clean -- %f");
    bed.git(bed.root, "config", "filter.lfs.smudge", "git-lfs smudge -- %f");
    bed.git(bed.root, "config", "filter.lfs.process", "git-lfs filter-process");
    changed();
    await guarded({ PATH }).run(bed.root, STATUS);
    expect(existsSync(lfsMarker), "the standard entries run git-lfs").toBe(true);
    rmSync(lfsMarker);
    const { script, marker } = bed.plant("fake");
    bed.git(bed.root, "config", "filter.lfs.clean", script);
    await guarded({ PATH }).run(bed.root, STATUS);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(lfsMarker)).toBe(false);
  });

  it("changes nothing for a repository without drivers", async () => {
    changed();
    const status = await guarded().run(bed.root, STATUS);
    expect(status.stdout.toString("utf8")).toContain("a.txt");
  });

  it("runs no filter of a nested repository for a diff (the gitlink's own config)", async () => {
    const { script, marker } = bed.plant("nested");
    const sub = join(bed.root, "sub");
    bed.initRepo(sub);
    writeFileSync(join(sub, ".gitattributes"), "*.txt filter=evil\n");
    bed.git(sub, "config", "filter.evil.clean", script);
    bed.git(bed.root, "add", "sub");
    bed.git(bed.root, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "gitlink");
    // Same size as before: git then has to run the clean filter to know whether the file changed.
    writeFileSync(join(sub, "a.txt"), "two\n");
    bed.git(bed.root, "diff", "HEAD");
    expect(existsSync(marker), "control: plain git diff runs the nested driver").toBe(true);
    rmSync(marker);
    await guarded().run(bed.root, DIFF);
    expect(existsSync(marker)).toBe(false);
  });

  it("empties a driver with an empty name", async () => {
    const { script, marker } = bed.plant("empty");
    writeFileSync(join(bed.root, ".gitattributes"), "*.txt filter=\n");
    writeFileSync(join(bed.root, ".git", "extra.cfg"), `[filter ""]\n\tclean = ${script}\n`);
    bed.git(bed.root, "config", "include.path", "extra.cfg");
    changed();
    bed.git(bed.root, "status", "--porcelain");
    expect(existsSync(marker), "control: plain git runs the driver").toBe(true);
    rmSync(marker);
    await guarded().run(bed.root, STATUS);
    expect(existsSync(marker)).toBe(false);
  });
});
