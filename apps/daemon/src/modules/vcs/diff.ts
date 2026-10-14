import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { type DiffSide, PapError, type ResultOf, VCS_LIMITS } from "@pap/contracts";
import { judgeName, judgePath, type Scope } from "../../kernel/fs/boundary.ts";
import type { DenySet } from "../../kernel/fs/deny-set.ts";
import { BoundaryError, openRegularFile } from "../../kernel/fs/safe-open.ts";
import { GitError, type GitRunner } from "../../kernel/git/runner.ts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import type { Logger } from "../../kernel/logger.ts";

export interface DiffEnv {
  readonly git: GitRunner;
  readonly deny: DenySet;
  readonly logger: Logger;
}

export interface DiffRequest {
  readonly path: string;
  readonly oldPath?: string | undefined;
  readonly from: DiffSide;
  readonly to: DiffSide;
}

const LIMIT = VCS_LIMITS.diffSideBytes;
/** A NUL in this many first bytes makes a side binary (M8R26). */
const BINARY_PROBE_BYTES = 8 * 1024;
/** git's exit code for an object or path that does not exist. */
const NO_SUCH_OBJECT = 128;

const NOT_THERE: ReadonlySet<string> = new Set(["ELOOP", "EACCES", "EPERM", "EISDIR", "ENXIO", "ENOTDIR"]);

/** A side: its bytes (at most `LIMIT + 1`) or null when it does not exist, and whether it is too large. */
interface Side {
  readonly body: Buffer | null;
  readonly large: boolean;
}
const MISSING: Side = { body: null, large: false };

async function readUpTo(handle: FileHandle, max: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(max);
  let filled = 0;
  while (filled < max) {
    const { bytesRead } = await handle.read(buffer, filled, max - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/** The file through the boundary, as the explorer reads it (M8R47). A refusal is `not_found`; a file that is not there is a null side. */
async function readWorktree(env: DiffEnv, scope: Scope, root: string, path: string): Promise<Side> {
  const judgement = await judgePath(join(root, path), scope, "read");
  if (!judgement.ok) {
    if (judgement.why === "missing") return MISSING;
    env.logger.debug("vcs_refused", { why: judgement.why });
    throw new PapError("not_found");
  }
  let handle: FileHandle | undefined;
  try {
    handle = await openRegularFile(judgement.real, { ...scope, root: judgement.root, deny: env.deny });
    const body = await readUpTo(handle, LIMIT + 1);
    return { body, large: body.length > LIMIT };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT") return MISSING;
    if (error instanceof BoundaryError || (typeof code === "string" && NOT_THERE.has(code))) {
      env.logger.debug("vcs_refused", { reason: error instanceof BoundaryError ? error.reason : code });
      throw new PapError("not_found");
    }
    throw error;
  } finally {
    await handle?.close().catch((error: unknown) => {
      env.logger.debug("vcs_close_failed", { code: (error as { code?: unknown }).code });
    });
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

async function readBlob(env: DiffEnv, root: string, spec: string): Promise<Side> {
  try {
    const out = await env.git.run(root, ["cat-file", "blob", spec], {
      okCodes: [0, NO_SUCH_OBJECT],
      maxBytes: LIMIT,
    });
    return out.code === 0 ? { body: out.stdout, large: out.stdout.length > LIMIT } : MISSING;
  } catch (error) {
    if (error instanceof GitError && error.kind === "too_large") return { body: null, large: true };
    if (error instanceof GitError && error.kind === "timeout") throw new PapError("timeout");
    throw error;
  }
}

function readSide(env: DiffEnv, scope: Scope, root: string, side: DiffSide, path: string): Promise<Side> {
  return side.kind === "worktree"
    ? readWorktree(env, scope, root, path)
    : readBlob(env, root, specOf(side, path));
}

type DiffAnswer = ResultOf<"vcs.fileDiff">;
const NO_TEXT = (over: Partial<DiffAnswer>): DiffAnswer => ({
  before: null,
  after: null,
  binary: false,
  truncated: false,
  ...over,
});

/**
 * One file between two sides (M8R47). Every name, blobs included, passes the boundary's name judgement before git runs:
 * a repository that tracks `$PAP_HOME` or Pi's private files, or a token asking for `.pi/mcp.json`, gets `not_found`.
 * `from` reads `oldPath` when there is one (a rename), `to` reads `path`.
 */
export async function readDiff(
  env: DiffEnv,
  scope: Scope,
  root: string,
  request: DiffRequest,
): Promise<DiffAnswer> {
  for (const path of [request.path, request.oldPath]) {
    if (path === undefined) continue;
    const refused = judgeName(join(root, path), scope);
    if (refused !== null) {
      env.logger.debug("vcs_refused", { why: refused });
      throw new PapError("not_found");
    }
  }
  const before = await readSide(env, scope, root, request.from, request.oldPath ?? request.path);
  const after = await readSide(env, scope, root, request.to, request.path);
  const sides = [before, after];
  if (sides.some((side) => side.body?.subarray(0, BINARY_PROBE_BYTES).includes(0)))
    return NO_TEXT({ binary: true });
  if (sides.some((side) => side.large)) return NO_TEXT({ truncated: true });
  const answer = NO_TEXT({
    before: before.body?.toString("utf8") ?? null,
    after: after.body?.toString("utf8") ?? null,
  });
  // The answer is one frame: two 400 KiB sides full of escapes may not fit (a page, M2R54).
  return sizeOf(answer) > PAGE_BYTES ? NO_TEXT({ truncated: true }) : answer;
}
