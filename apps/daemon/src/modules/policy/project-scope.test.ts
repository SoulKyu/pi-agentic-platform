import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectScopeOf } from "./project-scope.ts";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-scope-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("projectScopeOf", () => {
  it("is the git root of a folder inside a repository, the folder itself outside git (owner R2-5)", () => {
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    mkdirSync(join(root, "repo", "sub", "deep"), { recursive: true });
    mkdirSync(join(root, "worktree"), { recursive: true });
    writeFileSync(join(root, "worktree", ".git"), "gitdir: /elsewhere\n");
    mkdirSync(join(root, "plain"));
    symlinkSync(join(root, "repo", "sub"), join(root, "link"));
    expect(projectScopeOf(join(root, "repo", "sub", "deep"))).toBe(join(root, "repo"));
    expect(projectScopeOf(join(root, "repo"))).toBe(join(root, "repo"));
    expect(projectScopeOf(join(root, "worktree"))).toBe(join(root, "worktree"));
    expect(projectScopeOf(join(root, "link"))).toBe(join(root, "repo"));
    expect(projectScopeOf(join(root, "plain"))).toBe(join(root, "plain"));
  });

  it("takes the nearest .git, so a submodule is its own project", () => {
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    mkdirSync(join(root, "repo", "mod", "src"), { recursive: true });
    writeFileSync(join(root, "repo", "mod", ".git"), "gitdir: ../.git/modules/mod\n");
    expect(projectScopeOf(join(root, "repo", "mod", "src"))).toBe(join(root, "repo", "mod"));
  });

  it("looks at most 64 levels up: the 64th folder counts, the 65th does not", () => {
    mkdirSync(join(root, ".git"));
    const at = (depth: number) => join(root, ...Array.from({ length: depth }, (_, i) => `d${i}`));
    mkdirSync(at(64), { recursive: true });
    expect(projectScopeOf(at(63))).toBe(root);
    expect(projectScopeOf(at(64))).toBe(at(64));
  });

  it("does not take a .git that is neither a folder nor a file for a repository", () => {
    mkdirSync(join(root, "repo", "sub"), { recursive: true });
    symlinkSync(join(root, "nowhere"), join(root, "repo", ".git"));
    expect(projectScopeOf(join(root, "repo", "sub"))).toBe(join(root, "repo", "sub"));
  });

  it("falls back to the folder itself for a symlink loop, never looping", () => {
    symlinkSync(join(root, "b"), join(root, "a"));
    symlinkSync(join(root, "a"), join(root, "b"));
    mkdirSync(join(root, ".git"));
    expect(projectScopeOf(join(root, "a"))).toBe(join(root, "a"));
  });

  it("keeps a missing folder as its own project, never the repository above it", () => {
    mkdirSync(join(root, ".git"));
    const missing = join(root, "gone", "deeper");
    expect(projectScopeOf(missing)).toBe(missing);
    expect(projectScopeOf("relative/gone")).toBe(resolve("relative/gone"));
  });

  it("keeps a file as its own project: a cwd that is not a folder is never widened", () => {
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "afile"), "x");
    expect(projectScopeOf(join(root, "afile"))).toBe(join(root, "afile"));
  });

  it.skipIf(process.getuid?.() === 0)(
    "keeps the folder itself when .git cannot be looked up there, never the repository above",
    () => {
      mkdirSync(join(root, ".git"));
      mkdirSync(join(root, "locked"));
      chmodSync(join(root, "locked"), 0o600);
      try {
        expect(projectScopeOf(join(root, "locked"))).toBe(join(root, "locked"));
      } finally {
        chmodSync(join(root, "locked"), 0o700);
      }
    },
  );
});
