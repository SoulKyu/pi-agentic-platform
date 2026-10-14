import { createFakeClock, type FakeClock } from "../../../kernel/clock.ts";
import type { BoundaryConfig, CallerKind, Scope } from "../../../kernel/fs/boundary.ts";
import { createDenySet, type DenySet } from "../../../kernel/fs/deny-set.ts";
import type { GitRunner } from "../../../kernel/git/runner.ts";
import { createBoundaryBed } from "../../../kernel/testing/boundary-bed.ts";
import { createGitBed } from "../../../kernel/testing/git-bed.ts";
import { captureLogger } from "../../../testing/capture-logger.ts";

export type FakeAnswer = string | Buffer | { stdout: string | Buffer; code?: number } | Error;

/** A runner that answers from a function and records every argv it was given (`calls`). */
export function fakeGit(answer: (args: readonly string[]) => FakeAnswer): {
  git: GitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const git: GitRunner = {
    async run(_root, args) {
      calls.push([...args]);
      const given = answer(args);
      if (given instanceof Error) throw given;
      const { stdout, code } =
        typeof given === "string" || Buffer.isBuffer(given) ? { stdout: given, code: 0 } : given;
      return { stdout: Buffer.from(stdout), code: code ?? 0 };
    },
  };
  return { git, calls };
}

/** Temporary home, agent directory and pap home (`bb`), a real repository (`gb`), a fake clock and a capturing logger. */
export function createVcsBed() {
  const bb = createBoundaryBed();
  const gb = createGitBed();
  // Far ahead of every file the beds make: the deny set sees no file as changed since a walk.
  const clock: FakeClock = createFakeClock(Date.now() + 3_600_000);
  const { logger, lines } = captureLogger();
  const deny: DenySet = createDenySet(bb.denySources(), clock);
  return {
    bb,
    gb,
    clock,
    logger,
    lines,
    deny,
    repo: gb.root,
    git: gb.runner(),
    scope: (roots: readonly string[], caller: CallerKind = "session", config?: BoundaryConfig): Scope => ({
      roots,
      config: config ?? bb.config(),
      caller,
    }),
    dispose: (): void => {
      bb.dispose();
      gb.dispose();
    },
  };
}
export type VcsBed = ReturnType<typeof createVcsBed>;
