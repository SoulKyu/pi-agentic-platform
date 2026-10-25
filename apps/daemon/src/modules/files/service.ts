import type { FileHandle } from "node:fs/promises";
import { type Caller, FILE_LIMITS, PapError, type ParamsOf, type ResultOf } from "@pap/contracts";
import type { BoxOps, ProjectBoxSource } from "../../kernel/boxes.ts";
import type { Clock } from "../../kernel/clock.ts";
import type { BoundaryConfig, Scope } from "../../kernel/fs/boundary.ts";
import type { DenySet } from "../../kernel/fs/deny-set.ts";
import type { GitRunner } from "../../kernel/git/runner.ts";
import type { Logger } from "../../kernel/logger.ts";
import { type BoxRaw, createBoxFiles } from "./box-backend.ts";
import { judged, type WriteEnv } from "./access.ts";
import { createPathLock } from "./path-lock.ts";
import { listFolder } from "./list.ts";
import { rank } from "./rank.ts";
import { openRaw, readChunk } from "./read.ts";
import { type UploadService, uploadFile } from "./upload.ts";
import { writeText } from "./write.ts";
import { createSearchIndex, readableBy, type SearchIndex } from "./search-index.ts";

export interface FilesDeps {
  /** The caller's project roots (M8R15); a path is judged against them and nothing else. */
  roots(ownerId: string): readonly string[];
  readonly boundary: BoundaryConfig;
  readonly deny: DenySet;
  readonly git: GitRunner;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The database is read-only: every write is refused the same way (M8R105). */
  readonly readOnly: boolean;
  /** The workers' umask: a new file gets `0o666 & ~workerUmask` (R114). */
  readonly workerUmask: number;
  /** Late-bound (the boxes are wired after the files): with none bound, no path is a box path. */
  readonly boxes?: () => ProjectBoxSource | undefined;
  readonly boxOps?: () => BoxOps | undefined;
  /** A member reads and writes box paths only (M14); a host path is `forbidden` before any file-system call. */
  readonly isMember: (userId: string) => boolean;
}

export interface FilesService {
  list(caller: Caller, params: ParamsOf<"files.list">): Promise<ResultOf<"files.list">>;
  read(caller: Caller, params: ParamsOf<"files.read">): Promise<ResultOf<"files.read">>;
  search(caller: Caller, params: ParamsOf<"files.search">): Promise<ResultOf<"files.search">>;
  write(caller: Caller, params: ParamsOf<"files.write">): Promise<ResultOf<"files.write">>;
  /** For the raw route: the file open at its size now. The caller closes the handle. */
  openRaw(caller: Caller, path: string): Promise<{ readonly handle: FileHandle; readonly size: number }>;
  /** For the raw route: the guest's stream when the path is in a box project, else null (use `openRaw`). */
  openBoxRaw(caller: Caller, path: string): Promise<BoxRaw | null>;
}

export function createFilesService(
  deps: FilesDeps,
): FilesService & UploadService & { readonly index: SearchIndex } {
  const env: WriteEnv = {
    git: deps.git,
    deny: deps.deny,
    clock: deps.clock,
    logger: deps.logger,
    locks: createPathLock(),
  };
  const index = createSearchIndex(env);
  const box = createBoxFiles({
    boxes: deps.boxes ?? (() => undefined),
    ops: deps.boxOps ?? (() => undefined),
    clock: deps.clock,
    logger: deps.logger,
    readOnly: deps.readOnly,
    isMember: deps.isMember,
  });
  // The transport's caller, never the params, decides whose roots and which strictness apply (C 4.4, M8R29).
  const scopeOf = (caller: Caller): Scope => ({
    roots: deps.roots(caller.userId),
    config: deps.boundary,
    caller: caller.kind,
  });
  return {
    index,
    readOnly: deps.readOnly,
    async upload(caller, input) {
      if (deps.readOnly) throw new PapError("read_only");
      const inBox = box.match(caller, input.path);
      if (inBox) return box.upload(inBox, caller, input);
      return uploadFile(env, scopeOf(caller), caller, input, deps.workerUmask);
    },
    list(caller, params) {
      const inBox = box.match(caller, params.path);
      if (inBox) return box.list(inBox, caller, params);
      return listFolder(env, scopeOf(caller), params.path, params.showIgnored === true);
    },
    read(caller, params) {
      const inBox = box.match(caller, params.path);
      if (inBox) return box.read(inBox, caller, params);
      return readChunk(env, scopeOf(caller), params.path, params.offset);
    },
    async openBoxRaw(caller, path) {
      const inBox = box.match(caller, path);
      return inBox ? box.openRaw(inBox, caller, path) : null;
    },
    openRaw(caller, path) {
      if (deps.isMember(caller.userId)) throw new PapError("forbidden");
      return openRaw(env, scopeOf(caller), path);
    },
    async write(caller, params) {
      if (deps.readOnly) throw new PapError("read_only");
      const inBox = box.match(caller, params.path);
      if (inBox) return box.write(inBox, caller, params);
      return writeText(env, scopeOf(caller), caller, params, deps);
    },
    async search(caller, { root, query, limit }) {
      const inBox = box.match(caller, root);
      if (inBox) return box.search(inBox, caller, { root, query, limit });
      const scope = scopeOf(caller);
      // The root is one of the caller's, spelled exactly, and one the caller may open.
      if (!scope.roots.includes(root)) throw new PapError("not_found");
      await judged(env, scope, root, "list");
      const found = await index.paths(caller.userId, scope, root);
      const ranked = rank(found.paths, query, limit ?? FILE_LIMITS.searchResults, readableBy(scope, root));
      return { paths: ranked.paths, truncated: ranked.more || found.truncated };
    },
  };
}
