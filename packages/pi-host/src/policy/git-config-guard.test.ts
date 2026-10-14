import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GIT_INCLUDE,
  GIT_RUNS_PROGRAM,
  GIT_SUBMODULES,
  GIT_TOO_DEEP,
  GIT_TOO_MANY,
  GIT_UNREADABLE,
  gitGuard,
  MAX_GIT_CONFIG_BYTES,
  repoConfigRefusal,
} from "./git-config-guard.ts";
import { CLEAN, checker, DIRTY, gitDir, repo, tempRoot } from "./git-config-guard.fixtures.ts";

const LFS =
  '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n';

let root: string;
let home: string;

beforeEach(() => {
  ({ root, home } = tempRoot());
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const check = (start: string, files?: number) => checker(home)(start, files);

describe("a clean repository", () => {
  it("runs nothing, from its top and from src/", async () => {
    const top = repo(join(root, "r"));
    expect(await check(top)).toBeNull();
    expect(await check(join(top, "src"))).toBeNull();
  });

  it("is null outside any repository", async () => {
    mkdirSync(join(root, "plain"));
    expect(await check(join(root, "plain"))).toBeNull();
  });

  it("allows the standard git-lfs entries", async () => {
    const top = repo(join(root, "r"), CLEAN + LFS);
    expect(await check(join(top, "src"))).toBeNull();
  });

  it("allows core.fsmonitor with a boolean value, and the bare key", async () => {
    for (const line of ["fsmonitor = true", "fsmonitor = false", "fsmonitor = Off", "fsmonitor"]) {
      const top = repo(join(root, `r-${line.replace(/\W/g, "")}`), `${CLEAN}\t${line}\n`);
      expect(await check(join(top, "src")), line).toBeNull();
    }
  });
});

describe("program keys", () => {
  const OWNER_KEYS: ReadonlyArray<readonly [string, string]> = [
    ["core", "fsmonitor = /tmp/hook"],
    ["core", "fsmonitor = watchman"],
    ["diff", "external = x"],
    ['diff "d"', "command = x"],
    ['diff "d"', "textconv = x"],
    ['filter "lfs"', "clean = x"],
    ['filter "lfs"', "smudge = x"],
    ['filter "lfs"', "process = x"],
    ['filter "lfs"', "clean = git-lfs clean -- %f && touch x"],
    ['filter "other"', "clean = git-lfs clean -- %f"],
    ["core", "pager = x"],
    ["core", "editor = x"],
    ["core", "sshCommand = x"],
    ["gpg", "program = x"],
    ["credential", "helper = x"],
  ];
  it.each(OWNER_KEYS)("[%s] %s asks", async (section, line) => {
    const top = repo(join(root, "r"), `${CLEAN}[${section}]\n\t${line}\n`);
    expect(await check(join(top, "src"))).toBe(GIT_RUNS_PROGRAM);
  });

  it("asks for a standard lfs entry next to an altered one", async () => {
    const top = repo(join(root, "r"), `${CLEAN}${LFS}[filter "lfs"]\n\tsmudge = sh -c x\n`);
    expect(await check(top)).toBe(GIT_RUNS_PROGRAM);
  });

  it("config.worktree counts", async () => {
    const top = repo(join(root, "r"));
    writeFileSync(join(top, ".git", "config.worktree"), "[core]\n\tfsmonitor = /tmp/hook\n");
    expect(await check(join(top, "src"))).toBe(GIT_RUNS_PROGRAM);
  });
});

describe("unreadable configs", () => {
  it("asks for an unparsable config", async () => {
    const top = repo(join(root, "r"), "[core\n");
    expect(await check(top)).toBe(GIT_UNREADABLE);
  });

  it("asks for a FIFO without blocking", async () => {
    const top = repo(join(root, "r"), null);
    execFileSync("mkfifo", [join(top, ".git", "config")]);
    let result: string | null | undefined;
    check(top).then(
      (r) => {
        result = r;
      },
      (error: unknown) => {
        result = `threw: ${String(error)}`;
      },
    );
    await expect.poll(() => result, { timeout: 2000 }).toBe(GIT_UNREADABLE);
  });

  it("asks for a config that is a folder", async () => {
    const top = repo(join(root, "r"), null);
    mkdirSync(join(top, ".git", "config"));
    expect(await check(top)).toBe(GIT_UNREADABLE);
  });

  it("asks for a config over the size cap, and reads one at the cap", async () => {
    const pad = (n: number): string => `${CLEAN}# ${"x".repeat(n - CLEAN.length - 3)}\n`;
    const over = repo(join(root, "over"), pad(MAX_GIT_CONFIG_BYTES + 1));
    expect(await check(over)).toBe(GIT_UNREADABLE);
    const at = repo(join(root, "at"), pad(MAX_GIT_CONFIG_BYTES));
    expect(await check(at)).toBeNull();
  });

  it.skipIf(process.getuid?.() === 0)("asks for a config with mode 000", async () => {
    const top = repo(join(root, "r"));
    chmodSync(join(top, ".git", "config"), 0o000);
    expect(await check(top)).toBe(GIT_UNREADABLE);
  });
});

describe("includes", () => {
  it("reads include.path from the folder of the including file (the .git folder)", async () => {
    const top = repo(join(root, "r"), `${CLEAN}[include]\n\tpath = ../extra.cfg\n`);
    writeFileSync(join(top, "extra.cfg"), "[core]\n\tpager = x\n");
    expect(await check(top)).toBe(GIT_RUNS_PROGRAM);
  });

  it("reads includeIf whatever its condition", async () => {
    const top = repo(join(root, "r"), `${CLEAN}[includeIf "gitdir:/nowhere/"]\n\tpath = ../extra.cfg\n`);
    writeFileSync(join(top, "extra.cfg"), "[core]\n\teditor = x\n");
    expect(await check(top)).toBe(GIT_RUNS_PROGRAM);
  });

  it("resolves ~/ in the home", async () => {
    const top = repo(join(root, "r"), `${CLEAN}[include]\n\tpath = ~/inc.cfg\n`);
    writeFileSync(join(home, "inc.cfg"), "[credential]\n\thelper = x\n");
    expect(await check(top)).toBe(GIT_RUNS_PROGRAM);
  });

  it("allows a clean include", async () => {
    const top = repo(join(root, "r"), `${CLEAN}[include]\n\tpath = ../extra.cfg\n`);
    writeFileSync(join(top, "extra.cfg"), "[user]\n\tname = x\n");
    expect(await check(top)).toBeNull();
  });

  it.each([
    ["a missing file", "[include]\n\tpath = ../missing.cfg\n"],
    ["a bare path", "[include]\n\tpath\n"],
    ["~user", "[include]\n\tpath = ~other/x.cfg\n"],
    ["%(prefix)", "[include]\n\tpath = %(prefix)/x.cfg\n"],
    ["an empty path", '[include]\n\tpath = ""\n'],
  ])("asks for an include that cannot be resolved: %s", async (_name, include) => {
    const top = repo(join(root, "r"), CLEAN + include);
    expect(await check(top)).toBe(GIT_INCLUDE);
  });

  it("stops an include loop at git's depth", async () => {
    const top = repo(join(root, "r"), `${CLEAN}[include]\n\tpath = ../loop.cfg\n`);
    writeFileSync(join(top, "loop.cfg"), "[include]\n\tpath = loop.cfg\n");
    expect(await check(top)).toBe(GIT_INCLUDE);
  });

  it("asks for a chain longer than the file budget", async () => {
    const top = repo(join(root, "r"), `${CLEAN}[include]\n\tpath = ../c1.cfg\n`);
    for (let i = 1; i <= 6; i++)
      writeFileSync(
        join(top, `c${i}.cfg`),
        i < 6 ? `[include]\n\tpath = c${i + 1}.cfg\n` : "[user]\n\tname = x\n",
      );
    expect(await check(top, 5)).toBe(GIT_TOO_MANY);
    expect(await check(top)).toBeNull();
  });
});

describe("finding the repository git would discover", () => {
  it("reads the main config from a worktree (gitdir + commondir)", async () => {
    const main = repo(join(root, "main"), `${CLEAN}[core]\n\tpager = x\n`);
    const wt = join(main, ".git", "worktrees", "w");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, "HEAD"), "ref: refs/heads/w\n");
    writeFileSync(join(wt, "commondir"), "../..\n");
    const work = join(root, "work");
    mkdirSync(join(work, "src"), { recursive: true });
    writeFileSync(join(work, ".git"), `gitdir: ${wt}\n`);
    expect(await check(join(work, "src"))).toBe(GIT_RUNS_PROGRAM);
  });

  it("resolves a relative gitdir from the .git file's folder", async () => {
    gitDir(join(root, "store.git"), `${CLEAN}[core]\n\teditor = x\n`);
    const work = join(root, "work");
    mkdirSync(work);
    writeFileSync(join(work, ".git"), "gitdir: ../store.git\n");
    expect(await check(work)).toBe(GIT_RUNS_PROGRAM);
  });

  it("asks for a .git file without gitdir:", async () => {
    mkdirSync(join(root, "w"));
    writeFileSync(join(root, "w", ".git"), "nonsense\n");
    expect(await check(join(root, "w"))).toBe(GIT_UNREADABLE);
  });

  it("asks for a .git file whose gitdir is missing", async () => {
    mkdirSync(join(root, "w"));
    writeFileSync(join(root, "w", ".git"), `gitdir: ${join(root, "gone")}\n`);
    expect(await check(join(root, "w"))).toBe(GIT_UNREADABLE);
  });

  it("asks for .gitmodules at the top, and for .git/modules", async () => {
    const a = repo(join(root, "a"));
    writeFileSync(join(a, ".gitmodules"), "");
    expect(await check(join(a, "src"))).toBe(GIT_SUBMODULES);
    const b = repo(join(root, "b"));
    mkdirSync(join(b, ".git", "modules"));
    expect(await check(b)).toBe(GIT_SUBMODULES);
  });

  it("reads a bare-shaped folder", async () => {
    const bare = gitDir(join(root, "bare"), `${CLEAN}[core]\n\tpager = x\n`);
    expect(await check(bare)).toBe(GIT_RUNS_PROGRAM);
  });

  it("asks for an empty .git folder in src/ instead of reading the repository above (MC7)", async () => {
    const top = repo(join(root, "r"), DIRTY);
    mkdirSync(join(top, "src", ".git"));
    expect(await check(join(top, "src"))).toBe(GIT_UNREADABLE);
  });

  it("reads the inner repository only: a dirty outer one does not make a clean inner one ask", async () => {
    const outer = repo(join(root, "outer"), `${CLEAN}[core]\n\tpager = x\n`);
    const inner = repo(join(outer, "inner"));
    expect(await check(join(inner, "src"))).toBeNull();
  });

  it("asks for a dirty inner repository inside a clean outer one", async () => {
    const outer = repo(join(root, "outer"));
    const inner = repo(join(outer, "inner"), `${CLEAN}[core]\n\tpager = x\n`);
    expect(await check(join(inner, "src"))).toBe(GIT_RUNS_PROGRAM);
  });

  it("follows a .git link to a folder", async () => {
    const real = gitDir(join(root, "real-git"), `${CLEAN}[core]\n\tpager = x\n`);
    const work = join(root, "work");
    mkdirSync(work);
    symlinkSync(real, join(work, ".git"));
    expect(await check(work)).toBe(GIT_RUNS_PROGRAM);
  });

  it("finds a repository 64 levels up and asks for one 65 levels up", async () => {
    const down = (base: string, n: number): string => {
      let at = base;
      for (let i = 0; i < n; i++) at = join(at, "d");
      mkdirSync(at, { recursive: true });
      return at;
    };
    const near = repo(join(root, "near"));
    expect(await check(down(near, 64))).toBeNull();
    const far = repo(join(root, "far"));
    expect(await check(down(far, 65))).toBe(GIT_TOO_DEEP);
  });
});

describe("hooks git status runs (MC8)", () => {
  const hook = (dir: string, name: string): void => {
    mkdirSync(join(dir, "hooks"), { recursive: true });
    writeFileSync(join(dir, "hooks", name), "#!/bin/sh\n", { mode: 0o755 });
  };

  it("asks for core.hooksPath in the repository's config", async () => {
    const top = repo(join(root, "r"), `${CLEAN}[core]\n\thooksPath = .husky\n`);
    expect(await check(top)).toBe(GIT_RUNS_PROGRAM);
  });

  it("asks for hooks/post-index-change in the git directory", async () => {
    const top = repo(join(root, "r"));
    hook(join(top, ".git"), "post-index-change");
    expect(await check(join(top, "src"))).toBe(GIT_RUNS_PROGRAM);
  });

  it("asks for hooks/post-index-change in the common directory of a worktree", async () => {
    const main = repo(join(root, "main"));
    hook(join(main, ".git"), "post-index-change");
    const wt = join(main, ".git", "worktrees", "w");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, "HEAD"), "ref: refs/heads/w\n");
    writeFileSync(join(wt, "commondir"), "../..\n");
    const work = join(root, "work");
    mkdirSync(work);
    writeFileSync(join(work, ".git"), `gitdir: ${wt}\n`);
    expect(await check(work)).toBe(GIT_RUNS_PROGRAM);
  });

  it("does not ask for the other hooks, which status, diff and log never run", async () => {
    const top = repo(join(root, "r"));
    for (const name of ["pre-commit", "post-checkout", "commit-msg", "fsmonitor-watchman"])
      hook(join(top, ".git"), name);
    expect(await check(top)).toBeNull();
  });
});

describe("the verdict cache", () => {
  it("returns a cached refusal on the second call and spends no file budget", async () => {
    const top = repo(join(root, "r"), DIRTY);
    const guard = gitGuard(home);
    expect(await repoConfigRefusal(top, guard)).toBe(GIT_RUNS_PROGRAM);
    const left = guard.files;
    expect(await repoConfigRefusal(join(top, "src"), guard)).toBe(GIT_RUNS_PROGRAM);
    expect(guard.files).toBe(left);
  });

  it("keys the verdict by work tree too: two work trees sharing one git directory", async () => {
    const shared = gitDir(join(root, "shared.git"));
    const a = join(root, "a");
    const b = join(root, "b");
    for (const dir of [a, b]) mkdirSync(dir);
    writeFileSync(join(a, ".git"), `gitdir: ${shared}\n`);
    writeFileSync(join(b, ".git"), `gitdir: ${shared}\n`);
    writeFileSync(join(b, ".gitmodules"), "");
    const guard = gitGuard(home);
    expect(await repoConfigRefusal(a, guard)).toBeNull();
    expect(await repoConfigRefusal(b, guard)).toBe(GIT_SUBMODULES);
  });
});
