import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VcsStatus } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guestGitArgs } from "./git-run.ts";
import { type OpsBed, opsBed } from "./testing.ts";

let bed: OpsBed;
beforeEach(() => {
  bed = opsBed();
});
afterEach(() => bed.clean());

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
};
const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: bed.project, env: GIT_ENV, encoding: "utf8" });
const status = async () => VcsStatus.parse(await bed.value({ name: "git.status" }));

describe("git.status", () => {
  it("reports a folder without a repository as repo: false", async () => {
    expect(await status()).toMatchObject({ repo: false, files: [], error: null, root: bed.project });
  });

  it("reports status of a dirty repo with numstat", async () => {
    git("init", "-q", "-b", "main");
    writeFileSync(join(bed.project, "a.txt"), "one\ntwo\n");
    writeFileSync(join(bed.project, "b.txt"), "keep\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    writeFileSync(join(bed.project, "a.txt"), "one\nTWO\nthree\n");
    writeFileSync(join(bed.project, "new.txt"), "x\ny\n");
    writeFileSync(join(bed.project, "blob.bin"), Buffer.from([1, 0, 2]));
    mkdirSync(join(bed.project, "dir"));
    writeFileSync(join(bed.project, "dir", "inner.txt"), "i\n");

    const found = await status();
    expect(found).toMatchObject({
      repo: true,
      branch: "main",
      detached: false,
      error: null,
      truncated: false,
    });
    const byPath = new Map(found.files.map((file) => [file.path, file]));
    expect(byPath.get("a.txt")).toMatchObject({
      kind: "modified",
      additions: 2,
      deletions: 1,
      binary: false,
    });
    expect(byPath.get("new.txt")).toMatchObject({ kind: "untracked", additions: 2, deletions: 0 });
    expect(byPath.get("blob.bin")).toMatchObject({ kind: "untracked", binary: true, additions: null });
    expect(byPath.get("dir")).toMatchObject({ kind: "untracked", folder: true });
    expect(found.additions).toBe(4);
    expect(found.deletions).toBe(1);
  });

  it("a repo whose config sets core.fsmonitor never runs it", async () => {
    git("init", "-q", "-b", "main");
    writeFileSync(join(bed.project, "a.txt"), "one\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const marker = join(bed.outside, "ran");
    const hook = join(bed.outside, "hook.sh");
    writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(hook, 0o755);
    git("config", "core.fsmonitor", hook);
    git("config", "core.hooksPath", bed.outside);
    git("config", "diff.external", hook);
    // A clean filter would run on the files status compares.
    writeFileSync(join(bed.project, ".gitattributes"), "*.txt filter=spy\n");
    git("config", "filter.spy.clean", `${hook} %f`);
    writeFileSync(join(bed.project, "a.txt"), "changed\n");

    const found = await status();
    expect(found.files.map((file) => file.path).sort()).toEqual([".gitattributes", "a.txt"]);
    expect(found.error).toBeNull();
    expect(existsSync(marker)).toBe(false);
    // Control: the same config does run the program under a plain `git status`.
    execFileSync("git", ["status", "--porcelain"], { cwd: bed.project, env: GIT_ENV, stdio: "pipe" });
    expect(existsSync(marker)).toBe(true);
  });
});

describe("git.blob", () => {
  it("reads a path at the index, at head and at a commit, and says what is missing", async () => {
    git("init", "-q", "-b", "main");
    writeFileSync(join(bed.project, "a.txt"), "v1\n");
    writeFileSync(join(bed.project, "bin"), Buffer.from([0, 1]));
    git("add", "-A");
    git("commit", "-q", "-m", "one");
    const first = git("rev-parse", "HEAD").trim();
    writeFileSync(join(bed.project, "a.txt"), "v2\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "two");
    writeFileSync(join(bed.project, "a.txt"), "v3\n");
    git("add", "a.txt");

    const blob = (path: string, side: object) => bed.value({ name: "git.blob", path, side: side as never });
    expect(await blob("a.txt", { kind: "index" })).toEqual({ text: "v3\n", binary: false, truncated: false });
    expect(await blob("a.txt", { kind: "head" })).toEqual({ text: "v2\n", binary: false, truncated: false });
    expect(await blob("a.txt", { kind: "commit", oid: first })).toEqual({
      text: "v1\n",
      binary: false,
      truncated: false,
    });
    expect(await blob("bin", { kind: "head" })).toEqual({ text: null, binary: true, truncated: false });
    expect(await blob("nope.txt", { kind: "head" })).toEqual({ text: null, binary: false, truncated: false });
    expect(await bed.refusal({ name: "git.blob", path: "a.txt", side: { kind: "worktree" } })).toBe(
      "bad_request",
    );
  });
});

describe("the guest's git command line", () => {
  it("names the project as safe, exactly, and keeps the neutralised options", () => {
    const argv = guestGitArgs("/boxes/p/project", ["status"]);
    expect(argv.slice(0, 2)).toEqual(["-c", "safe.directory=/boxes/p/project"]);
    expect(argv).not.toContain("safe.directory=*");
    expect(argv).toContain("core.fsmonitor=false");
    expect(argv.slice(-1)).toEqual(["status"]);
  });
});
