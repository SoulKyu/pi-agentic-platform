import type { FileHandle } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { type Caller, PapError, type UploadAnswer } from "@pap/contracts";
import { gateWrite, type Scope } from "../../kernel/fs/boundary.ts";
import { uploadName } from "../../kernel/fs/names.ts";
import { BoundaryError, openRegularFile, writeAtomic } from "../../kernel/fs/safe-open.ts";
import { type FilesEnv, judged, refusal, type WriteEnv } from "./access.ts";

/** The largest upload (M8R34). */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export interface UploadInput {
  readonly path: string;
  readonly conflict: "skip" | "replace";
  readonly confirmProtected: boolean;
  /** The counted body: nothing is pulled before the boundary and the write gate have said yes. */
  readonly chunks: AsyncIterable<Uint8Array>;
}

export type UploadResult = UploadAnswer;

export interface UploadService {
  /** The database is read-only: the upload route answers before it looks at the body (M8R105). */
  readonly readOnly: boolean;
  /** `PUT /files/raw` (M8R34): places the streamed body, after the boundary and the write gate. */
  upload(caller: Caller, input: UploadInput): Promise<UploadResult>;
}

/** The mode of an existing target, read through the checked open (a private inode answers `not_found`). */
async function modeOf(
  env: FilesEnv,
  real: string,
  guard: Parameters<typeof openRegularFile>[1],
): Promise<number> {
  let handle: FileHandle | undefined;
  try {
    handle = await openRegularFile(real, guard);
    return (await handle.stat()).mode & 0o7777;
  } catch (error) {
    throw refusal(error, env.logger);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** M8R34: the name, the boundary, the write gate, then one atomic placement of the streamed body. */
export async function uploadFile(
  env: WriteEnv,
  scope: Scope,
  caller: Caller,
  input: UploadInput,
  workerUmask: number,
): Promise<UploadResult> {
  const cut = input.path.lastIndexOf("/");
  const name = uploadName(input.path.slice(cut + 1));
  if (cut < 0 || name === null) throw new PapError("bad_request");
  const path = input.path.slice(0, cut + 1) + name;
  const target = await judged(env, scope, path, "write");
  const gate = gateWrite({
    protection: target.protection,
    caller,
    confirmProtected: input.confirmProtected,
    now: env.clock.now(),
  });
  if (gate !== "ok") {
    env.logger.debug("file_write_gated", { gate, protection: target.protection, callerKind: caller.kind });
    throw new PapError(gate);
  }
  // The same chain as `files.write`: a save and an upload of one file take turns (MC38 m1).
  const size = await env.locks.run(target.real, async (): Promise<number | null> => {
    let existingMode: number | null = null;
    if (target.exists) {
      existingMode = await modeOf(env, target.real, target.guard);
      if (input.conflict === "skip") return null;
    }
    try {
      return await writeAtomic({
        real: target.real,
        guard: target.guard,
        chunks: input.chunks,
        maxBytes: UPLOAD_MAX_BYTES,
        mode: existingMode ?? 0o666 & ~workerUmask,
        replace: existingMode !== null,
      });
    } catch (error) {
      if (error instanceof BoundaryError && error.reason === "exists") {
        if (input.conflict === "skip") return null;
        throw new PapError("conflict");
      }
      if (error instanceof BoundaryError && error.reason === "too_large")
        throw new PapError("payload_too_large");
      throw refusal(error, env.logger);
    }
  });
  if (size === null) return { written: false };
  env.logger.info("file_uploaded", { protection: target.protection, callerKind: caller.kind });
  const placed = await stat(target.real).catch(() => null);
  // An upload is not read back: the explorer asks `files.read` for the etag and the kind.
  return {
    written: true,
    meta: {
      path,
      size,
      mtimeMs: Math.max(0, placed?.mtimeMs ?? env.clock.now()),
      etag: null,
      binary: false,
      editable: false,
      protection: target.protection,
    },
  };
}
