import {
  constants,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_FILE_LIMITS, AgentFilePath, AgentId, type AgentFileView, PapError } from "@pap/contracts";
import {
  ensurePrivateFolder,
  PRIVATE_TMP_PREFIX,
  PrivateFolderError,
  writePrivateFile,
} from "../../kernel/fs/private-write.ts";
import type { Logger } from "../../kernel/logger.ts";

/** Only the class of a failure is logged (its code), never its message: a path or a value could be in it. */
const errorClass = (error: unknown): string => (error as NodeJS.ErrnoException | null)?.code ?? "error";
/** No link at the end, and a pipe cannot block the open. */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CONFLICT_CODES = new Set(["EISDIR", "ENOTEMPTY", "EEXIST", "ENOTDIR"]);
/** `<id>-<stamp>` or `<id>-<stamp>-<n>`: the stamp is a 10 to 16 digit time, so an id that ends in digits is not taken for one (as trash.ts). */
const TRASH_ENTRY = /^(.+)-(\d{10,16})(?:-\d+)?$/;

interface Entry {
  readonly path: string;
  readonly absolute: string;
  readonly size: number;
  readonly importedAt: number;
}

export interface AgentFiles {
  /** The agent's files with their size and import date (never the content), by path. */
  list(agentId: string): AgentFileView[];
  /** Writes the file whole (a replace when the path exists). `bad_request`, `payload_too_large`, `limit_reached`, `conflict`. */
  put(agentId: string, path: string, bytes: Buffer): AgentFileView;
  /** Deletes the file and remembers the path as a pending removal until `delivered`. `not_found` when it is not there. */
  remove(agentId: string, path: string): void;
  /** Every file whole, by path: what the worker writes into the VM home. A link or an odd file is skipped. */
  read(agentId: string): Promise<Array<{ path: string; bytes: Buffer }>>;
  /** One file whole, or null when it is absent, not a regular file, a link (or below one), or over `AGENT_FILE_LIMITS.maxBytes`. */
  readOne(agentId: string, path: string): Promise<Buffer | null>;
  /**
   * What the explorer keeps out of sight: the imported paths plus the removals the VM has not heard of yet (their copy still sits in
   * its home). Fails closed: a folder or a removals file that cannot be read throws `internal` (logged once, no path), never an empty set.
   */
  hiddenOf(agentId: string): string[];
  /** The paths removed since the VM last heard of them: the worker deletes them from the home, then `delivered` clears them. */
  pendingRemovals(agentId: string): string[];
  delivered(agentId: string, removed: string[]): void;
  /** Called with the agent id and the path after an import or a removal (live delivery). A throwing listener is logged and skipped. */
  onChange(listener: (agentId: string, path: string) => void): void;
  /** The agent is deleted: its folder (and its pending removals) go to the trash as `<id>-<stamp>`. Safe to run again. */
  dispose(agentId: string, stamp: number): void;
  /** "Purge now": the agent's trash entries are deleted. */
  purgeTrash(agentId: string): void;
  /** Deletes the trash entries older than `keepMs`. */
  sweepTrash(now: number, keepMs: number): void;
}

/**
 * The files the owner imports into a VM agent's home (sub-project 2, spec 7), kept under
 * `<secretsDir>/agent-files/<agentId>/<path>`: real folders 0700 and files 0600, written whole to a temporary name and renamed,
 * never through a link (a link where a folder or the agent's folder should be is refused). The import date is the file's mtime.
 * The removals not yet delivered are kept beside, in `.removals/<agentId>.json`. Nothing here logs a path or a byte.
 */
export function createAgentFiles(deps: { readonly secretsDir: string; readonly logger: Logger }): AgentFiles {
  const { logger } = deps;
  const root = join(deps.secretsDir, "agent-files");
  const trashDir = join(root, ".trash");
  const removalsDir = join(root, ".removals");
  const listeners = new Set<(agentId: string, path: string) => void>();

  const idOf = (agentId: string): string => {
    if (!AgentId.safeParse(agentId).success) throw new PapError("bad_request");
    return agentId;
  };
  const pathOf = (path: string): string[] => {
    if (!AgentFilePath.safeParse(path).success) throw new PapError("bad_request");
    return path.split("/");
  };
  const tell = (agentId: string, path: string): void => {
    for (const listener of listeners) {
      try {
        listener(agentId, path);
      } catch (error) {
        logger.warn("agent_files_listener_failed", { err: errorClass(error) });
      }
    }
  };
  const failed = (event: string, error: unknown): PapError => {
    if (error instanceof PapError) return error;
    logger.error(event, { err: error instanceof PrivateFolderError ? error.reason : errorClass(error) });
    return new PapError("internal");
  };

  /** Files below `folder` (a real folder, else none), links and odd entries skipped, by path. */
  function walk(folder: string, prefix = "", strict = false): Entry[] {
    let names: string[];
    try {
      if (!lstatSync(folder).isDirectory()) return [];
      names = readdirSync(folder);
    } catch (error) {
      if (strict && errorClass(error) !== "ENOENT") throw error;
      return [];
    }
    const found: Entry[] = [];
    for (const name of names) {
      if (name.startsWith(PRIVATE_TMP_PREFIX)) continue;
      const absolute = join(folder, name);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(absolute);
      } catch (error) {
        if (strict && errorClass(error) !== "ENOENT") throw error;
        continue;
      }
      const path = prefix === "" ? name : `${prefix}/${name}`;
      if (stat.isDirectory()) found.push(...walk(absolute, path, strict));
      else if (stat.isFile())
        found.push({ path, absolute, size: stat.size, importedAt: Math.floor(stat.mtimeMs) });
    }
    return found;
  }
  const entriesOf = (agentId: string): Entry[] =>
    walk(join(root, idOf(agentId))).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const viewOf = (entry: Entry): AgentFileView => ({
    path: entry.path,
    size: entry.size,
    importedAt: entry.importedAt,
  });

  const removalsFile = (agentId: string): string => join(removalsDir, `${agentId}.json`);
  function pending(agentId: string, strict = false): string[] {
    let text: string;
    try {
      text = readFileSync(removalsFile(idOf(agentId)), "utf8");
    } catch (error) {
      if (strict && errorClass(error) !== "ENOENT") throw error;
      if (errorClass(error) !== "ENOENT")
        logger.warn("agent_files_removals_unreadable", { err: errorClass(error) });
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed)
        ? parsed.filter(
            (path): path is string => typeof path === "string" && AgentFilePath.safeParse(path).success,
          )
        : [];
    } catch {
      if (strict) throw new Error("not_json");
      logger.warn("agent_files_removals_unreadable", { err: "not_json" });
      return [];
    }
  }
  function savePending(agentId: string, paths: string[]): void {
    try {
      if (paths.length === 0) {
        rmSync(removalsFile(agentId), { force: true });
        return;
      }
      ensurePrivateFolder(removalsDir);
      writePrivateFile(removalsFile(agentId), Buffer.from(JSON.stringify(paths), "utf8"));
    } catch (error) {
      throw failed("agent_files_removals_write_failed", error);
    }
  }

  return {
    list: (agentId) => entriesOf(agentId).map(viewOf),

    put(agentId, path, bytes) {
      idOf(agentId);
      const segments = pathOf(path);
      if (bytes.length > AGENT_FILE_LIMITS.maxBytes) throw new PapError("payload_too_large");
      const existing = entriesOf(agentId);
      if (!existing.some((entry) => entry.path === path) && existing.length >= AGENT_FILE_LIMITS.maxFiles)
        throw new PapError("limit_reached");
      const folder = join(root, agentId);
      let parent = root;
      try {
        ensurePrivateFolder(root);
        for (const level of [agentId, ...segments.slice(0, -1)]) {
          parent = join(parent, level);
          ensurePrivateFolder(parent);
        }
      } catch (error) {
        if (error instanceof PrivateFolderError && error.reason === "not_a_directory")
          throw new PapError("conflict");
        if (CONFLICT_CODES.has(errorClass(error))) throw new PapError("conflict");
        throw failed("agent_files_folder_refused", error);
      }
      const target = join(folder, ...segments);
      try {
        writePrivateFile(target, bytes);
      } catch (error) {
        if (CONFLICT_CODES.has(errorClass(error))) throw new PapError("conflict");
        throw failed("agent_files_write_failed", error);
      }
      const stat = lstatSync(target);
      // A re-import of a path removed earlier and not yet delivered cancels the removal.
      const waiting = pending(agentId);
      if (waiting.includes(path))
        savePending(
          agentId,
          waiting.filter((each) => each !== path),
        );
      logger.info("agent_file_imported", { agentId });
      tell(agentId, path);
      return { path, size: stat.size, importedAt: Math.floor(stat.mtimeMs) };
    },

    remove(agentId, path) {
      idOf(agentId);
      const segments = pathOf(path);
      const folder = join(root, agentId);
      const target = join(folder, ...segments);
      let isFile = false;
      try {
        isFile = lstatSync(target).isFile();
      } catch {
        // Not there.
      }
      if (!isFile) throw new PapError("not_found");
      // The revocation is written first: if it cannot be, the file stays and nothing is lost; a pending removal whose
      // unlink then fails is harmless (the next start removes the file, then puts it again).
      const waiting = pending(agentId);
      if (!waiting.includes(path)) savePending(agentId, [...waiting, path]);
      try {
        unlinkSync(target);
        for (let depth = segments.length - 1; depth > 0; depth -= 1) {
          try {
            rmdirSync(join(folder, ...segments.slice(0, depth)));
          } catch {
            break; // Not empty: it holds other files.
          }
        }
      } catch (error) {
        throw failed("agent_files_remove_failed", error);
      }
      logger.info("agent_file_removed", { agentId });
      tell(agentId, path);
    },

    async read(agentId) {
      const files: Array<{ path: string; bytes: Buffer }> = [];
      for (const entry of entriesOf(agentId)) {
        let handle;
        try {
          handle = await open(entry.absolute, OPEN_FLAGS);
          if (!(await handle.stat()).isFile()) continue;
          files.push({ path: entry.path, bytes: await handle.readFile() });
        } catch (error) {
          // Gone since the walk, or swapped for a link: left out.
          if (errorClass(error) !== "ENOENT")
            logger.warn("agent_files_unreadable", { err: errorClass(error) });
        } finally {
          await handle?.close();
        }
      }
      return files;
    },

    async readOne(agentId, path) {
      idOf(agentId);
      const segments = pathOf(path);
      let folder = join(root, agentId);
      for (const level of segments.slice(0, -1)) {
        folder = join(folder, level);
        if (!isRealFolder(folder)) return null;
      }
      let handle;
      try {
        handle = await open(join(folder, segments[segments.length - 1] as string), OPEN_FLAGS);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > AGENT_FILE_LIMITS.maxBytes) return null;
        return await handle.readFile();
      } catch {
        return null;
      } finally {
        await handle?.close();
      }
    },

    hiddenOf(agentId) {
      idOf(agentId);
      try {
        const imported = walk(join(root, agentId), "", true).map((entry) => entry.path);
        return [...new Set([...imported, ...pending(agentId, true)])];
      } catch (error) {
        logger.error("agent_files_hidden_unreadable", { err: errorClass(error) });
        throw new PapError("internal");
      }
    },

    pendingRemovals: (agentId) => pending(agentId),

    delivered(agentId, removed) {
      const waiting = pending(agentId);
      const left = waiting.filter((path) => !removed.includes(path));
      if (left.length !== waiting.length) savePending(agentId, left);
    },

    onChange(listener) {
      listeners.add(listener);
    },

    dispose(agentId, stamp) {
      idOf(agentId);
      try {
        const source = join(root, agentId);
        savePending(agentId, []);
        if (!existsSync(source) && !isLink(source)) return;
        ensurePrivateFolder(trashDir);
        let target = join(trashDir, `${agentId}-${stamp}`);
        for (let next = 1; existsSync(target); next += 1)
          target = join(trashDir, `${agentId}-${stamp}-${next}`);
        renameSync(source, target);
      } catch (error) {
        throw failed("agent_files_dispose_failed", error);
      }
    },

    purgeTrash(agentId) {
      idOf(agentId);
      let names: string[];
      try {
        names = readdirSync(trashDir);
      } catch {
        return;
      }
      for (const name of names) {
        const match = TRASH_ENTRY.exec(name);
        if (match?.[1] === agentId && AgentId.safeParse(match[1]).success)
          rmSync(join(trashDir, name), { recursive: true, force: true });
      }
    },

    sweepTrash(now, keepMs) {
      let names: string[];
      try {
        names = readdirSync(trashDir);
      } catch {
        return;
      }
      for (const name of names) {
        const match = TRASH_ENTRY.exec(name);
        if (match === null || now - Number(match[2]) <= keepMs) continue;
        try {
          rmSync(join(trashDir, name), { recursive: true, force: true });
        } catch (error) {
          logger.warn("agent_files_trash_sweep_failed", { err: errorClass(error) });
        }
      }
    },
  };
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function isRealFolder(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
