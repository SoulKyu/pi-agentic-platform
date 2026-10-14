import { createHash } from "node:crypto";
import { type FileHandle, stat } from "node:fs/promises";
import { type Caller, FILE_LIMITS, type FileMeta, PapError, type ParamsOf } from "@pap/contracts";
import { gateWrite, type Scope } from "../../kernel/fs/boundary.ts";
import { BoundaryError, type OpenGuard, openRegularFile, writeAtomic } from "../../kernel/fs/safe-open.ts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import { type FilesEnv, judged, refusal, type WriteEnv } from "./access.ts";

const etagOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex").slice(0, 32);

/** Reads at most the editor's limit plus one byte, so a larger file is told from one that fits. */
async function readEditable(handle: FileHandle): Promise<Buffer | null> {
  const buffer = Buffer.allocUnsafe(FILE_LIMITS.editableBytes + 1);
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled > FILE_LIMITS.editableBytes ? null : buffer.subarray(0, filled);
}

/**
 * What the file on disk must be before it is replaced: it exists, is a regular file the boundary accepts, fits the
 * editor and hashes to `baseEtag`. Returns its mode. A hard link to a private file is `not_found` (the open refuses it).
 */
async function checkBase(
  env: FilesEnv,
  real: string,
  guard: OpenGuard,
  baseEtag: string | null,
): Promise<number> {
  let handle: FileHandle;
  try {
    handle = await openRegularFile(real, guard);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PapError("conflict");
    throw refusal(error, env.logger);
  }
  try {
    const mode = (await handle.stat()).mode & 0o7777;
    const body = await readEditable(handle);
    if (baseEtag === null || body === null || etagOf(body) !== baseEtag) throw new PapError("conflict");
    return mode;
  } catch (error) {
    throw refusal(error, env.logger);
  } finally {
    await handle.close();
  }
}

export interface WriteDeps {
  readonly workerUmask: number;
}

/** `files.write` (M8R30): the boundary, the write gate, the etag, then one atomic replace or exclusive creation. */
export async function writeText(
  env: WriteEnv,
  scope: Scope,
  caller: Caller,
  params: ParamsOf<"files.write">,
  deps: WriteDeps,
): Promise<{ meta: FileMeta }> {
  const { path, text, baseEtag } = params;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > FILE_LIMITS.editableBytes || sizeOf(text) > PAGE_BYTES)
    throw new PapError("payload_too_large");
  const target = await judged(env, scope, path, "write");
  const gate = gateWrite({
    protection: target.protection,
    caller,
    confirmProtected: params.confirmProtected === true,
    now: env.clock.now(),
  });
  if (gate !== "ok") {
    env.logger.debug("file_write_gated", { gate, protection: target.protection, callerKind: caller.kind });
    throw new PapError(gate);
  }
  // The check and the replace of one file never interleave with another writer's (MC38 m1).
  await env.locks.run(target.real, async () => {
    // An existing target is opened even for a creation, so a private inode answers not_found, not conflict.
    let existingMode: number | null = null;
    if (target.exists) existingMode = await checkBase(env, target.real, target.guard, baseEtag);
    else if (baseEtag !== null) throw new PapError("conflict");
    try {
      await writeAtomic({
        real: target.real,
        guard: target.guard,
        chunks: [bytes],
        maxBytes: FILE_LIMITS.editableBytes,
        mode: existingMode ?? 0o666 & ~deps.workerUmask,
        replace: existingMode !== null,
      });
    } catch (error) {
      if (error instanceof BoundaryError && error.reason === "exists") throw new PapError("conflict");
      if (error instanceof BoundaryError && error.reason === "too_large")
        throw new PapError("payload_too_large");
      throw refusal(error, env.logger);
    }
  });
  env.logger.info("file_written", { protection: target.protection, callerKind: caller.kind });
  const written = await stat(target.real).catch(() => null);
  return {
    meta: {
      path,
      size: bytes.length,
      mtimeMs: Math.max(0, written?.mtimeMs ?? env.clock.now()),
      etag: etagOf(bytes),
      binary: false,
      editable: sizeOf(text) <= PAGE_BYTES,
      protection: target.protection,
    },
  };
}
