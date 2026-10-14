import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { constants, copyFile, lstat, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { type AttachmentView, FILE_LIMITS, type ImageMime, PapError } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { BoundaryConfig } from "../../kernel/fs/boundary.ts";
import type { DenySet } from "../../kernel/fs/deny-set.ts";
import { uploadName } from "../../kernel/fs/names.ts";
import { BoundaryError, type OpenGuard, openRegularFile, writeAtomic } from "../../kernel/fs/safe-open.ts";
import type { Logger } from "../../kernel/logger.ts";
import { refusal } from "./access.ts";
import { createPendingBudget } from "./pending-budget.ts";
import { sniffImage } from "./sniff.ts";

/** A pending upload lives an hour (M8R37); a sweep every five minutes removes the ones past it. */
export const PENDING_TTL_MS = 60 * 60_000;
export const SWEEP_EVERY_MS = 5 * 60_000;
/** The boot size scan reads at most this many entries (M8R37 step 3). */
const SIZE_WALK_MAX = 10_000;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** pap's own folder: the client-path rules do not apply, the descriptor only has to stay in `pending/` (M8R39). */
const NO_BOUNDARY: BoundaryConfig = { papHome: [], agentDir: [], home: [], papHomeOpen: [], runtimeDirs: [] };

export interface ClaimedAttachments {
  readonly images: readonly { readonly id: string; readonly path: string; readonly mimeType: ImageMime }[];
  readonly files: readonly {
    readonly id: string;
    readonly path: string;
    readonly name: string;
    readonly size: number;
  }[];
}

/** What the sessions module uses (Task 8): a claim binds uploads to one session of the uploading user. */
export interface AttachmentsPort {
  claim(ownerId: string, sessionId: string, ids: readonly string[]): Promise<ClaimedAttachments>;
  /** The prompt was accepted: the claimed images are read and the files copied, so the uploads are spent (MC38 m3). */
  release(ownerId: string, ids: readonly string[]): void;
}

export interface Reservation {
  readonly bytes: number;
  keep(): void;
  cancel(): void;
}

export interface PutInput {
  readonly sessionId: string;
  readonly name: string;
  readonly chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}

export interface AttachmentsStore extends AttachmentsPort {
  /** Before the body is read: counts the declared length at once, or throws `limit_reached` (refuse, never evict). */
  reserve(ownerId: string, bytes: number): Reservation;
  /** Writes the body to `pending/<id>`; any failure cancels the reservation and leaves no file. */
  put(ownerId: string, reservation: Reservation, input: PutInput): Promise<AttachmentView>;
  stop(): void;
}

interface Entry {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly size: number;
  readonly kind: "image" | "file";
  readonly mimeType: ImageMime | null;
  expiresAt: number;
}

export interface AttachmentsOptions {
  /** `$PAP_HOME/attachments`. */
  readonly dir: string;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly deny: DenySet;
  readonly limits?: { readonly count: number; readonly bytes: number };
}

/** A bounded walk for the boot log line: the folder's total bytes (retention comes with M10's `attachment.cleanup`). */
function logSize(dir: string, logger: Logger): void {
  let bytes = 0;
  let entries = 0;
  let truncated = false;
  try {
    const stack = [dir];
    walk: while (stack.length > 0) {
      const folder = stack.pop() as string;
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (++entries > SIZE_WALK_MAX) {
          entries = SIZE_WALK_MAX;
          truncated = true;
          break walk;
        }
        const path = join(folder, entry.name);
        if (entry.isDirectory()) stack.push(path);
        else if (entry.isFile()) bytes += lstatSync(path).size;
      }
    }
  } catch {
    truncated = true;
  }
  logger.info("attachments_size", { bytes, entries, truncated });
}

/** M8R36 to M8R39: pending uploads in `pending/`, an in-memory index, claims that copy files per session. */
export function createAttachmentsStore(options: AttachmentsOptions): AttachmentsStore {
  const { clock, logger, deny } = options;
  mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(options.dir).isDirectory()) throw new Error("attachments path is not a directory");
  chmodSync(options.dir, 0o700);
  const root = realpathSync(options.dir);
  const pendingDir = join(root, "pending");
  // An index lost with the process is never rebuilt from disk (M8R36): what an earlier run left is removed.
  rmSync(pendingDir, { recursive: true, force: true });
  mkdirSync(pendingDir, { mode: 0o700 });
  logSize(root, logger);

  const guard: OpenGuard = {
    roots: [pendingDir],
    config: NO_BOUNDARY,
    caller: "session",
    root: pendingDir,
    deny,
  };
  const budget = createPendingBudget(
    options.limits ?? { count: FILE_LIMITS.pendingPerOwner, bytes: FILE_LIMITS.pendingBytesPerOwner },
  );
  const entries = new Map<string, Entry>();
  const pendingPath = (id: string): string => join(pendingDir, id);
  const dropFile = (id: string): void => {
    unlink(pendingPath(id)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") logger.warn("attachment_unlink_failed", {});
    });
  };
  const forget = (id: string, entry: Entry): void => {
    entries.delete(id);
    budget.release(entry.ownerId, entry.size);
    dropFile(id);
  };

  let stopped = false;
  let timer: TimerHandle | null = null;
  const sweep = (): void => {
    const now = clock.now();
    for (const [id, entry] of entries) if (now >= entry.expiresAt) forget(id, entry);
    if (!stopped) timer = clock.setTimeout(sweep, SWEEP_EVERY_MS);
  };
  timer = clock.setTimeout(sweep, SWEEP_EVERY_MS);

  /** The copy of a file claim: reused when an earlier claim already made it. */
  async function copyFor(id: string, entry: Entry): Promise<string> {
    const folder = join(root, entry.sessionId, id);
    const place = join(folder, entry.name);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    try {
      await copyFile(pendingPath(id), place, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const there = await lstat(place);
      if (!there.isFile() || there.size !== entry.size) throw new PapError("conflict");
    }
    return place;
  }

  async function claimNow(
    ownerId: string,
    sessionId: string,
    ids: readonly string[],
  ): Promise<ClaimedAttachments> {
    if (new Set(ids).size !== ids.length) throw new PapError("bad_request");
    const now = clock.now();
    const picked = ids.map((id) => {
      const entry = entries.get(id);
      if (
        entry === undefined ||
        entry.ownerId !== ownerId ||
        entry.sessionId !== sessionId ||
        now >= entry.expiresAt
      )
        throw new PapError("not_found");
      return { id, entry };
    });
    const images: Array<ClaimedAttachments["images"][number]> = [];
    const files: Array<ClaimedAttachments["files"][number]> = [];
    for (const { id, entry } of picked) {
      try {
        // The pending file must still be the regular, pap-written file and no private inode under another name.
        await (await openRegularFile(pendingPath(id), guard)).close();
        if (entry.kind === "image" && entry.mimeType !== null)
          images.push({ id, path: pendingPath(id), mimeType: entry.mimeType });
        else files.push({ id, path: await copyFor(id, entry), name: entry.name, size: entry.size });
        // A claimed image is read by the worker later (a prompt may wait behind a command): the sweep must not take it first.
        entry.expiresAt = clock.now() + PENDING_TTL_MS;
      } catch (error) {
        throw refusal(error, logger);
      }
    }
    return { images, files };
  }

  // One claim at a time: two claims of one upload never race on the copy.
  let claims: Promise<unknown> = Promise.resolve();
  return {
    reserve(ownerId, bytes) {
      const held = budget.reserve(ownerId, bytes);
      if (held === null) throw new PapError("limit_reached");
      return { bytes, keep: held.keep, cancel: held.cancel };
    },
    async put(ownerId, reservation, input) {
      try {
        if (uploadName(input.name) !== input.name || !SESSION_ID.test(input.sessionId))
          throw new PapError("bad_request");
        const id = randomBytes(16).toString("base64url");
        const head = Buffer.alloc(12);
        let seen = 0;
        const chunks = (async function* () {
          for await (const chunk of input.chunks) {
            if (seen < head.length)
              seen += Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).copy(head, seen);
            yield chunk;
          }
        })();
        let size: number;
        try {
          size = await writeAtomic({
            real: pendingPath(id),
            guard,
            chunks,
            maxBytes: reservation.bytes,
            mode: 0o600,
            replace: false,
          });
        } catch (error) {
          if (error instanceof BoundaryError && error.reason === "too_large")
            throw new PapError("payload_too_large");
          throw error;
        }
        if (size !== reservation.bytes) {
          await unlink(pendingPath(id)).catch(() => undefined);
          throw new PapError("bad_request");
        }
        const mimeType = sniffImage(head.subarray(0, Math.min(seen, head.length)), size);
        const entry: Entry = {
          ownerId,
          sessionId: input.sessionId,
          name: input.name,
          size,
          kind: mimeType === null ? "file" : "image",
          mimeType,
          expiresAt: clock.now() + PENDING_TTL_MS,
        };
        entries.set(id, entry);
        reservation.keep();
        logger.debug("attachment_stored", { kind: entry.kind, size });
        return { id, name: entry.name, size, kind: entry.kind, mimeType };
      } catch (error) {
        reservation.cancel();
        throw error;
      }
    },
    claim(ownerId, sessionId, ids) {
      const run = claims.then(() => claimNow(ownerId, sessionId, ids));
      claims = run.catch(() => undefined);
      return run;
    },
    release(ownerId, ids) {
      for (const id of ids) {
        const entry = entries.get(id);
        if (entry !== undefined && entry.ownerId === ownerId) forget(id, entry);
      }
    },
    stop() {
      stopped = true;
      if (timer !== null) clock.clearTimeout(timer);
    },
  };
}
