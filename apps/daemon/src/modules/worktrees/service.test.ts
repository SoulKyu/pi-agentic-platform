import { chmodSync, existsSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitError, type GitRunner, type GitRunOptions } from "../../kernel/git/runner.ts";
import { createWorktreesModule, WorktreeFailure, type WorktreesPort } from "./index.ts";
import { createWorktreesBed, OID, type WorktreesBed } from "./testing/bed.ts";

interface Call {
  readonly root: string;
  readonly args: readonly string[];
  readonly options: GitRunOptions | undefined;
}

let bed: WorktreesBed;
let repoRoot: string;
beforeEach(() => {
  bed = createWorktreesBed();
  repoRoot = join(bed.dir, "repo");
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
});
afterEach(() => bed.dispose());

/** A runner that records every call; `script` answers (or throws) first, the defaults describe a healthy repository. */
function fakeGit(script?: (call: Call) => Promise<string | undefined> | string | undefined) {
  const calls: Call[] = [];
  const known = new Set<string>();
  const adminNames = new Map<string, string>();
  const runner: GitRunner = {
    async run(root, args, options) {
      const call = { root, args, options };
      calls.push(call);
      const answer = await script?.(call);
      const out = (text: string) => ({ stdout: Buffer.from(text), code: 0 });
      if (answer !== undefined) return out(answer);
      if (args[0] === "worktree" && args[1] === "add") {
        // What git leaves behind: the folder with its .git file and the admin dir pointing back (MC3 I3).
        const path = args[4] as string;
        const admin = join(root, ".git", "worktrees", adminNames.get(path) ?? basename(path));
        mkdirSync(admin, { recursive: true });
        writeFileSync(join(admin, "gitdir"), `${join(path, ".git")}\n`);
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, ".git"), `gitdir: ${admin}\n`);
        known.add(path);
        return out("");
      }
      if (args[0] === "rev-parse" && args.includes("--git-common-dir")) return out(".git\n");
      if (args[0] === "rev-parse") return out(`${OID}\n`);
      if (args[0] === "worktree" && args[1] === "list")
        return out([...known].map((path) => `worktree ${path}\0HEAD ${OID}\0\0`).join(""));
      return out("");
    },
  };
  return {
    runner,
    calls,
    known,
    adminNames,
    commands: () =>
      calls.map((call) => call.args.join(" ")).filter((text) => !/git-common-dir|worktree list/.test(text)),
  };
}

const LANE = "fix-bug-1a2b";
const reserve = (module: WorktreesPort, laneId = LANE, ownerId = "o1") => {
  const path = bed.folder(laneId);
  module.reserve(
    ownerId,
    { path, workspaceId: "default", repoRoot, branch: `pap/${laneId}`, baseOid: OID, createdBranch: true },
    () => {},
  );
  return path;
};
const build = (git: GitRunner, diskFloor: (path: string) => undefined = () => undefined) =>
  createWorktreesModule({
    db: bed.db,
    git,
    clock: bed.clock,
    logger: bed.logger,
    papHome: bed.papHome,
    readOnly: false,
    diskFloor,
  });

describe("create and ready (M9R17)", () => {
  it("makes the branch, then adds the worktree locked, with the LFS switch and a 120 s deadline", async () => {
    const git = fakeGit();
    const module = build(git.runner);
    const path = reserve(module);
    await module.create(path);
    expect(git.commands()).toEqual([
      `branch --no-track pap/${LANE} ${OID}`,
      `worktree add --lock --reason=pap-creating ${path} pap/${LANE}`,
    ]);
    const add = git.calls.find((call) => call.args[0] === "worktree");
    expect(add?.options).toMatchObject({ env: { GIT_LFS_SKIP_SMUDGE: "1" }, timeoutMs: 120_000 });
    expect(add?.root).toBe(repoRoot);
    expect(module.byPath(path)?.state).toBe("creating");
  });

  it("unlocks on ready, then marks the row ready", async () => {
    const git = fakeGit();
    const module = build(git.runner);
    const path = reserve(module);
    await module.create(path);
    await module.ready(path);
    expect(git.commands().at(-1)).toBe(`worktree unlock ${path}`);
    expect(module.byPath(path)?.state).toBe("ready");
  });

  it("serialises two creations in one repository: the second's branch starts after the first's add settled", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const git = fakeGit(async ({ args }) => {
      if (args[0] === "worktree" && args[1] === "add" && args.includes(`pap/${LANE}`)) await gate;
    });
    const module = build(git.runner);
    const first = reserve(module);
    const second = reserve(module, "other-lane-3c4d");
    const done = [module.create(first), module.create(second)];
    await vi.waitFor(
      () => expect(git.commands().some((text) => text.startsWith("worktree add"))).toBe(true),
      {
        timeout: 5000,
      },
    );
    // The second creation has resolved the repository's key and waits; its branch must not have started.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(git.commands().filter((text) => text.startsWith("branch"))).toHaveLength(1);
    release();
    await Promise.all(done);
    expect(git.commands().map((text) => text.split(" ").slice(0, 2).join(" "))).toEqual([
      "branch --no-track",
      "worktree add",
      "branch --no-track",
      "worktree add",
    ]);
  });
});

describe("the lane's git dir is read back from git, checked and stored (MC3 I3)", () => {
  it("stores the admin dir git created, even when git added a counter to its name", async () => {
    const git = fakeGit();
    const path = bed.folder(LANE);
    git.adminNames.set(path, `${LANE}1`);
    const module = build(git.runner);
    reserve(module);
    await module.create(path);
    expect(module.gitDirOf(path)).toBe(join(repoRoot, ".git", "worktrees", `${LANE}1`));
    expect(module.byPath(path)?.gitDir).toBe(module.gitDirOf(path));
  });

  it("undoes the creation when the admin dir does not point back at the lane", async () => {
    const git = fakeGit(({ args, root }) => {
      if (args[0] === "worktree" && args[1] === "add") {
        const path = args[4] as string;
        const other = join(root, ".git", "worktrees", LANE);
        mkdirSync(other, { recursive: true });
        writeFileSync(join(other, "gitdir"), "/elsewhere/.git\n");
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, ".git"), `gitdir: ${other}\n`);
        return "";
      }
      return undefined;
    });
    const module = build(git.runner);
    const path = reserve(module);
    await expect(module.create(path)).rejects.toMatchObject({ step: "git" });
    expect(module.byPath(path)).toBeUndefined();
  });

  it("treats a lane without a stored git dir as dirty", async () => {
    const git = fakeGit();
    const module = build(git.runner);
    const path = reserve(module);
    mkdirSync(path, { recursive: true });
    expect(await module.remove({ path, force: false })).toEqual({ ok: false, reason: "dirty" });
  });
});

describe("failures run the undo inline (M9R17, M9-RT-03)", () => {
  it("unlocks, removes, deletes the folder, prunes, deletes the branch at its base and the row, and rejects with step git", async () => {
    const path = bed.folder(LANE);
    const git = fakeGit(({ args }) => {
      if (args[0] === "worktree" && args[1] === "add") {
        mkdirSync(path);
        git.known.add(path);
        throw new GitError("failed");
      }
    });
    const module = build(git.runner);
    reserve(module);
    await expect(module.create(path)).rejects.toMatchObject({ name: "WorktreeFailure", step: "git" });
    expect(git.commands()).toEqual([
      `branch --no-track pap/${LANE} ${OID}`,
      `worktree add --lock --reason=pap-creating ${path} pap/${LANE}`,
      `worktree unlock ${path}`,
      `worktree remove --force ${path}`,
      "worktree prune",
      `rev-parse --verify --quiet refs/heads/pap/${LANE}^{commit}`,
      `branch -D pap/${LANE}`,
    ]);
    expect(existsSync(path)).toBe(false);
    expect(module.byPath(path)).toBeUndefined();
  });

  it("four failing creations, then a fifth create, succeed: no slot is held", async () => {
    const git = fakeGit(({ args }) => {
      if (args[0] === "worktree" && args[1] === "add" && !args.some((arg) => arg.includes("good-lane")))
        throw new GitError("failed");
    });
    const module = build(git.runner);
    for (const id of ["aa-1111", "bb-2222", "cc-3333", "dd-4444"]) {
      const path = reserve(module, id);
      await expect(module.create(path)).rejects.toBeInstanceOf(WorktreeFailure);
    }
    const path = reserve(module, "good-lane-5555");
    await module.create(path);
    expect(module.forOwner("o1")).toHaveLength(1);
  });

  it("a disk floor that throws rejects with step disk, without any git call, and frees the row", async () => {
    const git = fakeGit();
    const module = build(git.runner, () => {
      throw new Error("low");
    });
    const path = reserve(module);
    await expect(module.create(path)).rejects.toMatchObject({ name: "WorktreeFailure", step: "disk" });
    expect(git.calls).toHaveLength(0);
    expect(module.byPath(path)).toBeUndefined();
  });

  it("asks the disk floor about pap's worktrees folder, created 0700", async () => {
    const asked: string[] = [];
    const module = build(fakeGit().runner, (path) => {
      asked.push(path);
      return undefined;
    });
    await module.create(reserve(module));
    expect(asked).toEqual([join(bed.papHome, "worktrees")]);
  });

  it("a worktrees folder that is a symlink rejects before any chmod and leaves the target's mode (T3-1)", async () => {
    const target = join(bed.dir, "elsewhere");
    mkdirSync(target);
    chmodSync(target, 0o755);
    rmSync(join(bed.papHome, "worktrees"), { recursive: true, force: true });
    symlinkSync(target, join(bed.papHome, "worktrees"));
    const git = fakeGit();
    const module = build(git.runner);
    await expect(module.create(reserve(module))).rejects.toThrow();
    expect(statSync(target).mode & 0o777).toBe(0o755);
    expect(git.calls).toHaveLength(0);
  });

  it("a failing unlock on ready undoes the creation and rejects", async () => {
    const git = fakeGit(({ args }) => {
      if (args[1] === "unlock") throw new GitError("failed");
    });
    const module = build(git.runner);
    const path = reserve(module);
    await module.create(path);
    await expect(module.ready(path)).rejects.toMatchObject({ step: "git" });
    expect(module.byPath(path)).toBeUndefined();
  });

  it("refuses a path that is not a lane folder under pap's home", () => {
    const module = build(fakeGit().runner);
    expect(() =>
      module.reserve(
        "o1",
        {
          path: join(bed.dir, "x-1a2b"),
          workspaceId: "default",
          repoRoot,
          branch: "pap/x",
          baseOid: OID,
          createdBranch: true,
        },
        () => {},
      ),
    ).toThrow();
  });
});

describe("remove (M9R19, MC1 I2)", () => {
  const ready = async (git: ReturnType<typeof fakeGit>) => {
    const module = build(git.runner);
    const path = reserve(module);
    await module.create(path);
    await module.ready(path);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "f.txt"), "x");
    git.known.add(path);
    git.calls.length = 0;
    return { module, path };
  };

  it("answers dirty without force when the guarded status reports a change, and touches nothing", async () => {
    const git = fakeGit(({ args }) =>
      args[0] === "status" ? "1 .M N... 100644 100644 100644 a b f.txt\0" : undefined,
    );
    const { module, path } = await ready(git);
    expect(await module.remove({ path, force: false })).toEqual({ ok: false, reason: "dirty" });
    const status = git.calls.find((call) => call.args[0] === "status");
    expect(status?.args).toEqual([
      "status",
      "--porcelain=v2",
      "-z",
      "--ignore-submodules=dirty",
      "--untracked-files=normal",
    ]);
    expect(status?.root).toBe(path);
    expect(status?.options?.gitDir).toBe(join(repoRoot, ".git", "worktrees", LANE));
    expect(git.commands().some((text) => text.startsWith("worktree unlock"))).toBe(false);
    expect(module.byPath(path)?.state).toBe("ready");
  });

  it("unlocks first, then removes with --force, prunes and deletes the row and the folder", async () => {
    const git = fakeGit();
    const { module, path } = await ready(git);
    expect(await module.remove({ path, force: false })).toEqual({ ok: true });
    expect(git.commands()).toEqual([
      "status --porcelain=v2 -z --ignore-submodules=dirty --untracked-files=normal",
      `worktree unlock ${path}`,
      `worktree remove --force ${path}`,
      "worktree prune",
    ]);
    expect(module.byPath(path)).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });

  it("with force it does not ask status at all", async () => {
    const git = fakeGit(({ args }) => (args[0] === "status" ? "dirty" : undefined));
    const { module, path } = await ready(git);
    expect(await module.remove({ path, force: true })).toEqual({ ok: true });
    expect(git.commands().some((text) => text.startsWith("status"))).toBe(false);
  });
});

describe("deleteBranch (M9R19)", () => {
  it("runs -d only (never -D), and reports a failure as false", async () => {
    let fail = true;
    const git = fakeGit(({ args }) => {
      if (args[0] === "branch" && fail) throw new GitError("failed");
    });
    const module = build(git.runner);
    expect(await module.deleteBranch({ repoRoot, branch: "pap/x" })).toBe(false);
    fail = false;
    expect(await module.deleteBranch({ repoRoot, branch: "pap/x" })).toBe(true);
    expect(git.commands()).toEqual(["branch -d pap/x", "branch -d pap/x"]);
  });

  it("refuses a name that is not a branch pattern without calling git", async () => {
    const git = fakeGit();
    expect(await build(git.runner).deleteBranch({ repoRoot, branch: "--evil" })).toBe(false);
    expect(git.calls).toHaveLength(0);
  });
});
