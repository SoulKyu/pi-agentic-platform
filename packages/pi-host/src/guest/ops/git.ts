import { closeSync, constants, fstatSync, lstatSync } from "node:fs";
import {
  buildStatus,
  type DiffSide,
  emptyStatus,
  GIT_NUMSTAT_ARGS,
  GIT_STATUS_ARGS,
  type LineCount,
  parseNumstat,
  parsePorcelainV2,
  VCS_LIMITS,
  type VcsStatus,
} from "@pap/contracts/pi-host";
import { openAt } from "../../nofollow.ts";
import { readAt } from "./fs-read.ts";
import { runGit } from "./git-run.ts";
import { OpError, type OpEnv, withParent } from "./paths.ts";

/** A NUL in this many first bytes makes a file or a side binary. */
const BINARY_PROBE_BYTES = 8 * 1024;
/** Fresh reads of untracked files one status may make. */
const LINE_READS_PER_RUN = 200;
const NOT_COUNTED: LineCount = { additions: null, binary: false };
const BINARY: LineCount = { additions: null, binary: true };
/** git's exit code for an object or path that does not exist. */
const NO_SUCH_OBJECT = 128;

function linesOf(body: Buffer): number {
  let lines = 0;
  for (let at = body.indexOf(10); at !== -1; at = body.indexOf(10, at + 1)) lines += 1;
  return body.length > 0 && body[body.length - 1] !== 10 ? lines + 1 : lines;
}

/** Line counts of untracked files, which `git diff` does not know: opened with no link followed, bounded like the host's. */
function lineCounter(env: OpEnv): (path: string) => Promise<LineCount> {
  let reads = 0;
  return (path) => {
    if (reads >= LINE_READS_PER_RUN) return Promise.resolve(NOT_COUNTED);
    try {
      return Promise.resolve(
        withParent(env, `${env.project}/${path}`, (parent, name) => {
          const fd = openAt(parent, name, constants.O_RDONLY);
          try {
            if (fstatSync(fd).size > VCS_LIMITS.diffSideBytes) return NOT_COUNTED;
            reads += 1;
            const body = readAt(fd, 0, VCS_LIMITS.diffSideBytes + 1);
            if (body.length > VCS_LIMITS.diffSideBytes) return NOT_COUNTED;
            return body.subarray(0, BINARY_PROBE_BYTES).includes(0)
              ? BINARY
              : { additions: linesOf(body), binary: false };
          } finally {
            closeSync(fd);
          }
        }),
      );
    } catch {
      return Promise.resolve(NOT_COUNTED);
    }
  };
}

function hasGitEntry(project: string): boolean {
  try {
    lstatSync(`${project}/.git`);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/** `git.status`: the host's vcs snapshot (porcelain v2 status, numstat, line counts of untracked files) of the project. Never throws. */
export async function gitStatus(env: OpEnv): Promise<VcsStatus> {
  const at = env.now();
  const root = env.project;
  try {
    if (!hasGitEntry(root)) return emptyStatus(root, at, false, null);
    const parsed = parsePorcelainV2((await runGit(root, GIT_STATUS_ARGS)).stdout);
    // An unborn branch has no HEAD to compare with.
    const numstat =
      parsed.branch.oid === null ? null : parseNumstat((await runGit(root, GIT_NUMSTAT_ARGS)).stdout);
    return await buildStatus({ root, at, parsed, numstat, count: lineCounter(env) });
  } catch (error) {
    const code = error instanceof OpError ? error.code : "failed";
    if (code === "timeout") return emptyStatus(root, at, true, "timeout");
    if (code === "payload_too_large") return emptyStatus(root, at, true, "too_large");
    return emptyStatus(root, at, true, "failed");
  }
}

const specOf = (side: Exclude<DiffSide, { kind: "worktree" }>, path: string): string => {
  switch (side.kind) {
    // `:0:` names stage 0 explicitly, so a path that looks like `0:x` is not read as a stage.
    case "index":
      return `:0:${path}`;
    case "head":
      return `HEAD:${path}`;
    case "commit":
      return `${side.oid}:${path}`;
  }
};

/**
 * `git.blob`: the file `path` as `side` has it (the daemon already put a rename's old path in `path`). The worktree side is
 * the Files ops' (`fs.read`), not this one.
 */
export async function gitBlob(
  env: OpEnv,
  args: { readonly path: string; readonly side: DiffSide },
): Promise<{ text: string | null; binary: boolean; truncated: boolean }> {
  if (args.side.kind === "worktree") throw new OpError("bad_request");
  let out;
  try {
    out = await runGit(env.project, ["cat-file", "blob", specOf(args.side, args.path)], {
      okCodes: [0, NO_SUCH_OBJECT],
      maxBytes: VCS_LIMITS.diffSideBytes,
    });
  } catch (error) {
    if (error instanceof OpError && error.code === "payload_too_large") {
      return { text: null, binary: false, truncated: true };
    }
    throw error;
  }
  if (out.code !== 0) return { text: null, binary: false, truncated: false };
  if (out.stdout.subarray(0, BINARY_PROBE_BYTES).includes(0))
    return { text: null, binary: true, truncated: false };
  return { text: out.stdout.toString("utf8"), binary: false, truncated: false };
}
