import { join } from "node:path";
import { type DiffSide, PapError, type ResultOf, VCS_LIMITS, type VcsStatus } from "@pap/contracts";
import type { BoxOps } from "../../kernel/boxes.ts";
import { judgeBoxName, type Scope } from "../../kernel/fs/boundary.ts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { DiffRequest } from "./diff.ts";

type DiffAnswer = ResultOf<"vcs.fileDiff">;

const LIMIT = VCS_LIMITS.diffSideBytes;
const NO_TEXT = (over: Partial<DiffAnswer>): DiffAnswer => ({
  before: null,
  after: null,
  binary: false,
  truncated: false,
  ...over,
});

/**
 * The status of a box project's folder, from the guest's git; `root` is the one the subscription is keyed on. The poll's own
 * timer (`timed`) asks with `poll`, which never resets the box's idle wait: watching Changes does not keep a box alive.
 */
export async function readBoxStatus(
  ops: BoxOps,
  projectId: string,
  root: string,
  timed: boolean,
): Promise<VcsStatus> {
  const op = { name: "git.status" } as const;
  return { ...(await (timed ? ops.poll(projectId, op) : ops.call(projectId, op))), root };
}

interface Side {
  readonly text: string | null;
  readonly binary: boolean;
  readonly truncated: boolean;
}
const MISSING: Side = { text: null, binary: false, truncated: false };

/** The worktree side is the file as the explorer reads it; a file that is not there is a null side. */
async function worktreeSide(ops: BoxOps, projectId: string, root: string, path: string): Promise<Side> {
  try {
    const read = await ops.call(projectId, { name: "fs.read", path: join(root, path), offset: 0 });
    if (read.meta.binary) return { text: null, binary: true, truncated: false };
    if (read.meta.size > LIMIT || read.nextOffset !== null)
      return { text: null, binary: false, truncated: true };
    return { text: read.text, binary: false, truncated: false };
  } catch (error) {
    if (error instanceof PapError && error.code === "not_found") return MISSING;
    throw error;
  }
}

async function readSide(
  ops: BoxOps,
  projectId: string,
  root: string,
  side: DiffSide,
  path: string,
): Promise<Side> {
  return side.kind === "worktree"
    ? worktreeSide(ops, projectId, root, path)
    : await ops.call(projectId, { name: "git.blob", path, side });
}

/**
 * One file between two sides, as the host's `readDiff` answers it: the same name judgement first, the worktree side from
 * `fs.read` and the others from `git.blob`. `from` reads `oldPath` when there is one (a rename), `to` reads `path`.
 */
export async function readBoxDiff(
  env: { readonly ops: BoxOps; readonly logger: Logger },
  caller: Scope["caller"],
  target: { readonly projectId: string; readonly root: string },
  request: DiffRequest,
): Promise<DiffAnswer> {
  for (const path of [request.path, request.oldPath]) {
    if (path === undefined) continue;
    // The name alone, relative to the project folder: the host's folders are not in a box (and under the process backend the
    // box sits in `$PAP_HOME`, which the host's judge would refuse whole).
    const refused = judgeBoxName(`/${path}`, caller);
    if (refused !== null) {
      env.logger.debug("vcs_refused", { why: refused });
      throw new PapError("not_found");
    }
  }
  const { projectId, root } = target;
  const before = await readSide(env.ops, projectId, root, request.from, request.oldPath ?? request.path);
  const after = await readSide(env.ops, projectId, root, request.to, request.path);
  if ([before, after].some((side) => side.binary)) return NO_TEXT({ binary: true });
  if ([before, after].some((side) => side.truncated)) return NO_TEXT({ truncated: true });
  const answer = NO_TEXT({ before: before.text, after: after.text });
  return sizeOf(answer) > PAGE_BYTES ? NO_TEXT({ truncated: true }) : answer;
}
