import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";

export type ForkRefusalKind = "not_a_user_message" | "empty" | "unreadable" | "too_large";

export class ForkRefusal extends Error {
  readonly refusal: ForkRefusalKind;
  constructor(refusal: ForkRefusalKind) {
    super(refusal);
    this.name = "ForkRefusal";
    this.refusal = refusal;
  }
}

export interface PiWriter {
  fork(
    sourceFile: string,
    entryId: string,
  ): { file: string | null; piSessionId: string | null; text: string };
  clone(
    sourceFile: string,
    leafId: string | null,
    name: string | null,
  ): { file: string; piSessionId: string };
}

type Sdk = { SessionManager: typeof PiSessionManager; CURRENT_SESSION_VERSION: number };

/**
 * Opening a source parses all of it, synchronously, on the daemon's thread: past this a fork or a clone is refused
 * (`too_large`) rather than stall every other request.
 */
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024;

export interface PiWriterOptions {
  readonly maxSourceBytes?: number;
}

/**
 * The source's complete lines, as a copy to open. A worker may be appending to the source, and `SessionManager.open()`
 * writes to what it opens: it appends a newline to a file whose last line is torn, and rewrites one that is empty or in
 * an older format. So the source is only ever read here (M2-RT-16, ADR 0009); Pi opens the copy.
 */
function readCompleteLines(file: string, max: number): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    if (size > max) throw new ForkRefusal("too_large");
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buffer, read, size - read, read);
      if (n === 0) break;
      read += n;
    }
    // A line without its newline is one still being written (or torn): not part of the copy.
    return buffer.subarray(0, buffer.subarray(0, read).lastIndexOf(0x0a) + 1);
  } catch (error) {
    if (error instanceof ForkRefusal) throw error;
    throw new ForkRefusal("unreadable");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A Pi session file starts with its header; an older format would be migrated (rewritten) by `open()`. */
function headerIsCurrent(copy: Buffer, current: number): boolean {
  const end = copy.indexOf(0x0a);
  if (end <= 0) return false;
  try {
    const header = JSON.parse(copy.toString("utf8", 0, end)) as {
      type?: unknown;
      id?: unknown;
      version?: unknown;
    };
    return (
      header.type === "session" &&
      typeof header.id === "string" &&
      typeof header.version === "number" &&
      header.version >= current
    );
  } catch {
    return false;
  }
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .flatMap((block) =>
            (block as { type?: unknown }).type === "text"
              ? [String((block as { text?: unknown }).text ?? "")]
              : [],
          )
          .join("\n")
      : "";

// Pi writes a file only once a user or assistant message exists (S1): a branch without one is not worth a file.
const hasMessage = (manager: PiSessionManager, leafId: string): boolean =>
  manager
    .getBranch(leafId)
    .some(
      (entry) =>
        entry.type === "message" &&
        ["user", "assistant"].includes((entry.message as { role?: string }).role ?? ""),
    );

function createPiWriter(sdk: Sdk, scratchDir: string, options: PiWriterOptions): PiWriter {
  const max = options.maxSourceBytes ?? MAX_SOURCE_BYTES;
  /**
   * Runs `use` on a fresh manager over a private copy of the source, then deletes the copy, whatever happens. A fresh
   * manager per call: `createBranchedSession()` repoints the instance it runs on.
   */
  function withCopy<T>(sourceFile: string, use: (manager: PiSessionManager) => T): T {
    const copy = readCompleteLines(sourceFile, max);
    if (!headerIsCurrent(copy, sdk.CURRENT_SESSION_VERSION)) throw new ForkRefusal("unreadable");
    mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
    const work = mkdtempSync(join(scratchDir, "copy-"));
    try {
      const path = join(work, "source.jsonl");
      writeFileSync(path, copy, { mode: 0o600 });
      let manager: PiSessionManager;
      try {
        // The new file goes where the source is, which is Pi's folder for the session's cwd.
        manager = sdk.SessionManager.open(path, dirname(sourceFile));
      } catch {
        throw new ForkRefusal("unreadable");
      }
      // The header of a branched session names the file it was branched from: the source, not the copy.
      (manager as unknown as { sessionFile: string }).sessionFile = sourceFile;
      return use(manager);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  return {
    fork: (sourceFile, entryId) =>
      withCopy(sourceFile, (manager) => {
        const entry = manager.getEntry(entryId);
        if (!entry || entry.type !== "message" || (entry.message as { role?: string }).role !== "user")
          throw new ForkRefusal("not_a_user_message");
        const text = textOf((entry.message as { content?: unknown }).content);
        if (!entry.parentId || !hasMessage(manager, entry.parentId))
          return { file: null, piSessionId: null, text };
        const file = manager.createBranchedSession(entry.parentId);
        if (!file) throw new ForkRefusal("unreadable");
        return { file, piSessionId: manager.getSessionId(), text };
      }),
    clone: (sourceFile, leafId, name) =>
      withCopy(sourceFile, (manager) => {
        const leaf = (leafId && manager.getEntry(leafId) ? leafId : null) ?? manager.getLeafId();
        if (!leaf || !hasMessage(manager, leaf)) throw new ForkRefusal("empty");
        const file = manager.createBranchedSession(leaf);
        if (!file) throw new ForkRefusal("unreadable");
        if (name) manager.appendSessionInfo(name);
        return { file, piSessionId: manager.getSessionId() };
      }),
  };
}

let loading: Promise<Sdk> | undefined;
/** The SDK is heavy and loaded once, when the first fork or clone asks for it (R108). */
export function loadPiWriter(scratchDir: string, options: PiWriterOptions = {}): Promise<PiWriter> {
  loading ??= import("@earendil-works/pi-coding-agent").then(
    (sdk) => ({ SessionManager: sdk.SessionManager, CURRENT_SESSION_VERSION: sdk.CURRENT_SESSION_VERSION }),
    (error: unknown) => {
      loading = undefined;
      throw error;
    },
  );
  return loading.then((sdk) => createPiWriter(sdk, scratchDir, options));
}
