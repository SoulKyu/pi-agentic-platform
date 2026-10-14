import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitGuard, repoConfigRefusal } from "./git-config-guard.ts";

/** Repositories built by hand for the git config guard tests (no git run): HEAD, objects/, refs/ and a config. */

export const CLEAN = "[core]\n\trepositoryformatversion = 0\n\tbare = false\n";
export const DIRTY = `${CLEAN}[core]\n\tpager = x\n`;

export function tempRoot(): { readonly root: string; readonly home: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pap-git-guard-")));
  const home = join(root, "home");
  mkdirSync(home);
  return { root, home };
}

export function gitDir(dir: string, config: string | null = CLEAN): string {
  mkdirSync(join(dir, "objects"), { recursive: true });
  mkdirSync(join(dir, "refs"), { recursive: true });
  writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");
  if (config !== null) writeFileSync(join(dir, "config"), config);
  return dir;
}

export function repo(top: string, config: string | null = CLEAN): string {
  mkdirSync(join(top, "src"), { recursive: true });
  gitDir(join(top, ".git"), config);
  return top;
}

export function checker(home: string) {
  return (start: string, files?: number): Promise<string | null> => {
    const guard = gitGuard(home);
    if (files !== undefined) guard.files = files;
    return repoConfigRefusal(start, guard);
  };
}
