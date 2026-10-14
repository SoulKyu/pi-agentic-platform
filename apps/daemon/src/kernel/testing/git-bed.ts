import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "../logger.ts";
import { createGitRunner, type GitRunner } from "../git/runner.ts";

export interface GitBed {
  dir: string;
  home: string;
  root: string;
  /** Plain git, as the owner would run it (no pap flags): used to set up and as the control that proves a plant fires. */
  git(cwd: string, ...args: string[]): string;
  setupEnv(): NodeJS.ProcessEnv;
  runner(base?: NodeJS.ProcessEnv): GitRunner;
  initRepo(path: string): void;
  /** A script that records that it ran; the marker's absence is the assertion. */
  plant(name: string): { script: string; marker: string };
  dispose(): void;
}

/** A temporary HOME and a repository `root` with one commit (a.txt, -rf, "a\nb"), for tests that run real git. */
export function createGitBed(): GitBed {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pap-git-int-")));
  const home = join(dir, "home");
  mkdirSync(home);
  const setupEnv = (): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  });
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, env: setupEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const initRepo = (path: string): void => {
    mkdirSync(path, { recursive: true });
    git(path, "init", "-q", "-b", "main");
    writeFileSync(join(path, "a.txt"), "one\n");
    writeFileSync(join(path, "-rf"), "dash\n");
    writeFileSync(join(path, "a\nb"), "newline\n");
    git(path, "add", ".");
    git(path, "commit", "-q", "-m", "init");
  };
  const root = join(dir, "repo");
  initRepo(root);
  return {
    dir,
    home,
    root,
    git,
    setupEnv,
    runner: (base = {}) =>
      createGitRunner({ env: { PATH: process.env.PATH, HOME: home, ...base }, logger: silentLogger }),
    initRepo,
    plant(name) {
      const marker = join(dir, `${name}.marker`);
      const script = join(dir, `${name}.sh`);
      writeFileSync(script, `#!/bin/sh\necho ran > '${marker}'\ncat >/dev/null 2>&1 </dev/null\nexit 0\n`);
      chmodSync(script, 0o755);
      return { script, marker };
    },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}
