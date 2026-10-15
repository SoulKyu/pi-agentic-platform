import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { BRANCH_PATTERN } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitBed, type GitBed } from "../testing/git-bed.ts";
import { guardFilters } from "./filters.ts";
import { PAP_IDENTITY } from "./runner.ts";
import { stageInput } from "./stage.ts";

// M9 lanes with real git: the shapes, the pinned work tree, and the filters and editors a repository can plant.
let bed: GitBed;
beforeEach(() => {
  bed = createGitBed();
});
afterEach(() => bed.dispose());

const git = () => guardFilters(bed.runner());
const text = (out: { stdout: Buffer }): string => out.stdout.toString("utf8");
const head = (): string => bed.git(bed.root, "rev-parse", "HEAD").trim();
const IDENTITY = {
  GIT_AUTHOR_NAME: PAP_IDENTITY.name,
  GIT_AUTHOR_EMAIL: PAP_IDENTITY.email,
  GIT_COMMITTER_NAME: PAP_IDENTITY.name,
  GIT_COMMITTER_EMAIL: PAP_IDENTITY.email,
};
/** The lane's git dir from pap's own record, never from the lane's `.git` file (MC1 I4). */
const gitDirOf = (path: string): string => join(bed.root, ".git", "worktrees", basename(path));
const STAGE = ["add", "--pathspec-from-file=-", "--pathspec-file-nul"];
const COMMIT = ["commit", "--file=-", "--no-gpg-sign", "--quiet", "--", "./a.txt"];
/** Stage `paths` and commit them as pap, in a lane. */
async function checkpoint(path: string, paths: string[], message = "checkpoint\n"): Promise<void> {
  const gitDir = gitDirOf(path);
  await git().run(path, STAGE, { gitDir, input: stageInput(paths) ?? Buffer.alloc(0) });
  await git().run(path, COMMIT, { gitDir, input: Buffer.from(message), env: IDENTITY });
}
const ADD = ["worktree", "add", "--lock", "--reason=pap-creating"];

async function lane(name: string): Promise<string> {
  const path = join(bed.dir, name);
  await git().run(bed.root, ["branch", "--no-track", `pi/${name}`, head()]);
  await git().run(bed.root, [...ADD, path, `pi/${name}`]);
  return path;
}

describe("worktree lifecycle through the runner (M9-RT-03)", () => {
  it("creates a locked worktree, lists it locked, and unlocks it", async () => {
    const path = await lane("one");
    const listed = text(await git().run(bed.root, ["worktree", "list", "--porcelain", "-z"]));
    expect(listed).toContain("locked pap-creating");
    expect(existsSync(join(path, "a.txt"))).toBe(true);
    await git().run(bed.root, ["worktree", "unlock", path]);
    expect(text(await git().run(bed.root, ["worktree", "list", "--porcelain", "-z"]))).not.toContain(
      "locked",
    );
  });

  it("removes a locked worktree whose folder is gone: unlock, remove --force, prune, branch -D", async () => {
    const path = await lane("gone");
    rmSync(path, { recursive: true, force: true });
    await git().run(bed.root, ["worktree", "unlock", path]);
    await git().run(bed.root, ["worktree", "remove", "--force", path]);
    await git().run(bed.root, ["worktree", "prune"]);
    await git().run(bed.root, ["branch", "-D", "pi/gone"]);
    expect(bed.git(bed.root, "branch", "--list", "pi/gone").trim()).toBe("");
    expect(text(await git().run(bed.root, ["worktree", "list", "--porcelain"]))).not.toContain("gone");
  });

  it("answers the index path of a worktree", async () => {
    const path = await lane("idx");
    const out = text(await git().run(path, ["rev-parse", "--git-path", "index"])).trim();
    expect(out).toMatch(/\/worktrees\/idx\/index$/);
  });

  it("check-ref-format --branch exits 0 for names BRANCH_PATTERN refuses, one of them expanded (why the pattern comes first)", async () => {
    bed.git(bed.root, "switch", "-q", "-c", "other");
    bed.git(bed.root, "switch", "-q", "main");
    const at = await git().run(bed.root, ["check-ref-format", "--branch", "@"]);
    expect(at.code).toBe(0);
    expect(BRANCH_PATTERN.test("@")).toBe(false);
    // git 2.53 echoes `@`; `@{-1}` expands to the previous branch, a name other than the one given.
    const previous = await git().run(bed.root, ["check-ref-format", "--branch", "@{-1}"]);
    expect(text(previous).trim()).toBe("other");
    expect(BRANCH_PATTERN.test("@{-1}")).toBe(false);
  });
});

describe("a planted filter driver does not run through the lane subcommands (MC13, M9R13)", () => {
  it("worktree add, add, commit and restore", async () => {
    const { script, marker } = bed.plant("filter");
    writeFileSync(join(bed.root, ".gitattributes"), "*.txt filter=evil\n");
    bed.git(bed.root, "add", ".gitattributes");
    bed.git(bed.root, "commit", "-q", "-m", "attributes");
    for (const kind of ["clean", "smudge"]) bed.git(bed.root, "config", `filter.evil.${kind}`, script);

    bed.git(bed.root, "worktree", "add", join(bed.dir, "control"), "-b", "control");
    expect(existsSync(marker), "control: plain git runs the smudge driver").toBe(true);
    rmSync(marker);

    const path = await lane("filtered");
    expect(existsSync(marker), "worktree add").toBe(false);
    const base = head();

    writeFileSync(join(path, "a.txt"), "changed\n");
    await checkpoint(path, ["a.txt"]);
    expect(existsSync(marker), "add and commit").toBe(false);
    await git().run(path, ["restore", `--source=${base}`, "--worktree", "--staged", "--", "."], {
      gitDir: gitDirOf(path),
    });
    expect(existsSync(marker), "restore").toBe(false);
    expect(readFileSync(join(path, "a.txt"), "utf8")).toBe("one\n");
  });
});

describe("a planted editor does not run (M9R10)", () => {
  it("commit through the runner", async () => {
    const { script, marker } = bed.plant("editor");
    bed.git(bed.root, "config", "core.editor", script);
    try {
      bed.git(bed.root, "commit", "--allow-empty");
    } catch {
      // an empty message aborts the commit; the marker is the control
    }
    expect(existsSync(marker), "control: plain git runs the editor").toBe(true);
    rmSync(marker);
    const path = await lane("editor");
    writeFileSync(join(path, "a.txt"), "two\n");
    await checkpoint(path, ["a.txt"], "by pap\n");
    expect(existsSync(marker)).toBe(false);
    expect(bed.git(path, "log", "-1", "--format=%an <%ae> %s").trim()).toBe(
      "pap <pap@users.noreply.invalid> by pap",
    );
  });
});

describe("a lane whose config.worktree points elsewhere (M9R10, M9-RT-11 d)", () => {
  it("restore touches only the lane (`clean` left the allowlist, final review M1)", async () => {
    const path = await lane("pinned");
    const victim = join(bed.dir, "victim");
    mkdirSync(victim);
    writeFileSync(join(victim, "victim.txt"), "keep\n");
    writeFileSync(join(victim, "a.txt"), "victim a\n");
    bed.git(bed.root, "config", "extensions.worktreeConfig", "true");
    bed.git(path, "config", "--worktree", "core.worktree", victim);
    writeFileSync(join(path, "lane-only.txt"), "x\n");

    writeFileSync(join(path, "a.txt"), "changed\n");
    await git().run(path, ["restore", `--source=${head()}`, "--worktree", "--staged", "--", "."], {
      gitDir: gitDirOf(path),
    });
    expect(readFileSync(join(path, "a.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(victim, "a.txt"), "utf8")).toBe("victim a\n");
    expect(readFileSync(join(victim, "victim.txt"), "utf8")).toBe("keep\n");
  });
});

describe("update-ref cannot follow a symbolic ref (MC1 I1)", () => {
  it("moves and deletes the ref itself, never the branch it points at", async () => {
    const lanes = "refs/pap/checkpoints/fix-a-1a2b";
    const first = head();
    bed.git(bed.root, "branch", "keep");
    bed.git(bed.root, "commit", "-q", "--allow-empty", "-m", "second");
    const second = head();
    bed.git(bed.root, "symbolic-ref", `${lanes}/root`, "refs/heads/main");
    bed.git(bed.root, "symbolic-ref", `${lanes}/undo`, "refs/heads/keep");
    await git().run(bed.root, ["update-ref", "--no-deref", `${lanes}/root`, first]);
    await git().run(bed.root, ["update-ref", "--no-deref", "-d", `${lanes}/undo`]);
    expect(bed.git(bed.root, "rev-parse", "refs/heads/main").trim()).toBe(second);
    expect(bed.git(bed.root, "rev-parse", "refs/heads/keep").trim()).toBe(first);
    expect(bed.git(bed.root, "rev-parse", `${lanes}/root`).trim()).toBe(first);
    expect(bed.git(bed.root, "for-each-ref", `${lanes}/undo`).trim()).toBe("");
    // The control: the same moves without the option are refused by the allowlist, and plain git follows the symref.
    await expect(git().run(bed.root, ["update-ref", `${lanes}/root`, second])).rejects.toMatchObject({
      kind: "failed",
    });
    bed.git(bed.root, "symbolic-ref", `${lanes}/root`, "refs/heads/main");
    bed.git(bed.root, "update-ref", `${lanes}/root`, first);
    expect(bed.git(bed.root, "rev-parse", "refs/heads/main").trim()).toBe(first);
  });
});

describe("worktree remove needs --force (MC1 I2)", () => {
  it("does not run a driver of the lane's own config.worktree", async () => {
    const { script, marker } = bed.plant("remove");
    const path = await lane("rm");
    bed.git(bed.root, "config", "extensions.worktreeConfig", "true");
    bed.git(path, "config", "--worktree", "filter.evil.clean", script);
    writeFileSync(join(path, ".gitattributes"), "*.txt filter=evil\n");
    writeFileSync(join(path, "a.txt"), "changed\n");
    await expect(git().run(bed.root, ["worktree", "remove", path])).rejects.toMatchObject({ kind: "failed" });
    expect(existsSync(marker), "refused before git starts").toBe(false);
    await git().run(bed.root, ["worktree", "unlock", path]);
    await git().run(bed.root, ["worktree", "remove", "--force", path]);
    expect(existsSync(marker), "remove --force").toBe(false);
    expect(existsSync(path)).toBe(false);
  });
});

describe("staging an explicit list (MC1 I3)", () => {
  async function nested(): Promise<{ path: string; marker: string }> {
    const { script, marker } = bed.plant("nested");
    const path = await lane("stage");
    const sub = join(path, "sub");
    bed.initRepo(sub);
    writeFileSync(join(sub, ".gitattributes"), "*.txt filter=evil\n");
    bed.git(sub, "config", "filter.evil.clean", script);
    bed.git(path, "add", "-f", "sub");
    bed.git(path, "commit", "-q", "-m", "gitlink");
    // Same size, new mtime: git must hash the file to know, which runs the clean filter.
    writeFileSync(join(sub, "a.txt"), "two\n");
    writeFileSync(join(path, "a.txt"), "changed\n");
    return { path, marker };
  }

  it("does not run a nested repository's clean filter, where add -A does", async () => {
    const { path, marker } = await nested();
    bed.git(path, "add", "-A", "--", ".");
    expect(existsSync(marker), "control: plain add -A runs the nested filter").toBe(true);
    rmSync(marker);
    bed.git(path, "reset", "-q");
    await checkpoint(path, ["a.txt"]);
    expect(existsSync(marker)).toBe(false);
    expect(bed.git(path, "log", "-1", "--format=%an").trim()).toBe("pap");
  });

  it("is literal: a pathspec magic name stages nothing but itself", async () => {
    const path = await lane("literal");
    writeFileSync(join(path, "x.txt"), "x\n");
    writeFileSync(join(path, ":(glob)*.txt"), "magic\n");
    await git().run(path, STAGE, {
      gitDir: gitDirOf(path),
      input: stageInput([":(glob)*.txt"]) ?? Buffer.alloc(0),
    });
    expect(bed.git(path, "diff", "--cached", "--name-only").trim()).toBe(":(glob)*.txt");
  });

  it("stages a deletion", async () => {
    const path = await lane("deleted");
    rmSync(join(path, "a.txt"));
    await git().run(path, STAGE, { gitDir: gitDirOf(path), input: stageInput(["a.txt"]) ?? Buffer.alloc(0) });
    expect(bed.git(path, "diff", "--cached", "--name-status").trim()).toBe("D\ta.txt");
  });
});

describe("a rewritten lane .git file (MC1 I4)", () => {
  it("redirects neither restore --staged nor commit to the owner's index or branch", async () => {
    const path = await lane("hijack");
    const mainHead = head();
    writeFileSync(join(bed.root, "owner.txt"), "owner\n");
    bed.git(bed.root, "add", "owner.txt");
    writeFileSync(join(path, ".git"), `gitdir: ${join(bed.root, ".git")}\n`);
    writeFileSync(join(path, "a.txt"), "changed\n");

    const gitDir = gitDirOf(path);
    await git().run(path, ["restore", `--source=${mainHead}`, "--worktree", "--staged", "--", "."], {
      gitDir,
    });
    expect(bed.git(bed.root, "diff", "--cached", "--name-only").trim(), "the owner's index").toBe(
      "owner.txt",
    );

    writeFileSync(join(path, "a.txt"), "changed again\n");
    await checkpoint(path, ["a.txt"], "pap checkpoint\n");
    expect(bed.git(bed.root, "log", "-1", "--format=%s", "main").trim(), "the owner's branch").toBe("init");
    expect(bed.git(bed.root, "log", "-1", "--format=%s", "pi/hijack").trim()).toBe("pap checkpoint");
    expect(bed.git(bed.root, "diff", "--cached", "--name-only").trim()).toBe("owner.txt");
  });
});
