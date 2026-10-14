import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createFakeClock, type FakeClock } from "../../../kernel/clock.ts";
import type { BoundaryConfig, CallerKind, Scope } from "../../../kernel/fs/boundary.ts";
import { createDenySet, type DenySet } from "../../../kernel/fs/deny-set.ts";
import type { GitRunner } from "../../../kernel/git/runner.ts";
import type { Logger } from "../../../kernel/logger.ts";
import { captureLogger } from "../../../testing/capture-logger.ts";
import { createBoundaryBed } from "../../../kernel/testing/boundary-bed.ts";
import { createGitBed } from "../../../kernel/testing/git-bed.ts";

/** Temporary home, agent directory, pap home and a real repository: nothing here is the real `~`, `~/.pi` or `~/.pap`. */
export function createFilesBed() {
  const bb = createBoundaryBed();
  const gb = createGitBed();
  // Far ahead of every file the beds make: the deny set sees no file as changed since a walk.
  const clock: FakeClock = createFakeClock(Date.now() + 3_600_000);
  const { logger, lines } = captureLogger();
  const deny: DenySet = createDenySet(bb.denySources(), clock);
  const git: GitRunner = gb.runner();
  const file = (path: string, content = "x"): string => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  };
  return {
    bb,
    gb,
    clock,
    logger,
    lines,
    deny,
    git,
    /** A repository with `.gitignore`, ignored `node_modules/`, `dist/` and a tracked `dist/keep.txt`. */
    repo: gb.root,
    file,
    link: (target: string, path: string): void => {
      mkdirSync(dirname(path), { recursive: true });
      symlinkSync(target, path);
    },
    fifo: (path: string): void => {
      execFileSync("mkfifo", [path]);
    },
    scope: (roots: readonly string[], caller: CallerKind = "session", config?: BoundaryConfig): Scope => ({
      roots,
      config: config ?? bb.config(),
      caller,
    }),
    env: (over: Partial<{ git: GitRunner; logger: Logger }> = {}) => ({
      git,
      deny,
      clock,
      logger,
      ...over,
    }),
    dispose: (): void => {
      bb.dispose();
      gb.dispose();
    },
  };
}
export type FilesBed = ReturnType<typeof createFilesBed>;
