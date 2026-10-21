import { closeSync, constants, fchmodSync, mkdirSync, writeSync } from "node:fs";
import {
  AGENT_FILE_LIMITS,
  AgentFilePath,
  type HomePut as HomePutSchema,
  type HomeRemove as HomeRemoveSchema,
  type HomeResult as HomeResultSchema,
} from "@pap/contracts";
import type { z } from "zod";
import { closeQuietly, openAt, openDirAt, openRootDir, renameAt, unlinkAt } from "./nofollow.ts";

/**
 * The owner's imported files in a VM worker's home (sub-project 2, spec 7, AVM2-E8). The agent owns the home and may plant
 * links anywhere in it, so nothing here opens a path as a whole: the home is opened by its own path, then each folder of the
 * file's path is opened from its parent's descriptor with O_NOFOLLOW | O_DIRECTORY (`openDirAt`), the part file is created
 * exclusively without following a link, and it takes its name with a rename inside the opened folder, which replaces a link
 * at that name instead of following it. The path is checked again here (`AgentFilePath`): the wire is not trusted.
 */

export type HomePut = z.infer<typeof HomePutSchema>;
export type HomeRemove = z.infer<typeof HomeRemoveSchema>;
export type HomeResult = z.infer<typeof HomeResultSchema>;

const FOLDER_MODE = 0o700;
const FILE_MODE = 0o600;
/** The daemon sends one file at a time; a few more cover a retry after a lost answer. */
const MAX_OPEN_TRANSFERS = 4;

interface Transfer {
  readonly fd: number;
  readonly dirFd: number;
  readonly path: string;
  readonly name: string;
  written: number;
}

const partOf = (id: string): string => `.${id}.part`;
const result = (type: HomeResult["type"], id: string, code?: NonNullable<HomeResult["code"]>): HomeResult =>
  code === undefined ? { type, id, ok: true } : { type, id, ok: false, code };
const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

export function createHomeFiles(homeDir: string): {
  put(chunk: HomePut): Promise<HomeResult>;
  remove(request: HomeRemove): Promise<HomeResult>;
} {
  const transfers = new Map<string, Transfer>();

  const segmentsOf = (path: string): string[] => {
    if (!AgentFilePath.safeParse(path).success) throw new Error("path refused");
    return path.split("/");
  };

  /** The folder holding the file, every level opened from its parent's descriptor, a link refused at each. */
  const openParent = (folders: readonly string[], create: boolean): number => {
    let current: number;
    try {
      current = openRootDir(homeDir);
    } catch (error) {
      if (!create || codeOf(error) !== "ENOENT") throw error;
      mkdirSync(homeDir, { recursive: true, mode: FOLDER_MODE });
      current = openRootDir(homeDir);
    }
    try {
      for (const name of folders) {
        const next = openDirAt(current, name, create ? { create: FOLDER_MODE } : {});
        closeSync(current);
        current = next;
      }
    } catch (error) {
      closeQuietly(current);
      throw error;
    }
    return current;
  };

  const abandon = (id: string): void => {
    const transfer = transfers.get(id);
    if (transfer === undefined) return;
    transfers.delete(id);
    closeQuietly(transfer.fd);
    try {
      unlinkAt(transfer.dirFd, partOf(id));
    } catch {
      // already gone
    }
    closeQuietly(transfer.dirFd);
  };

  const begin = (chunk: HomePut): Transfer => {
    if (transfers.size >= MAX_OPEN_TRANSFERS) throw new Error("too many transfers");
    const segments = segmentsOf(chunk.path);
    const name = segments[segments.length - 1] as string;
    const dirFd = openParent(segments.slice(0, -1), true);
    try {
      const fd = openAt(
        dirFd,
        partOf(chunk.id),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        FILE_MODE,
      );
      fchmodSync(fd, FILE_MODE);
      const transfer = { fd, dirFd, path: chunk.path, name, written: 0 };
      transfers.set(chunk.id, transfer);
      return transfer;
    } catch (error) {
      closeQuietly(dirFd);
      throw error;
    }
  };

  const finish = (id: string, transfer: Transfer): HomeResult => {
    transfers.delete(id);
    closeSync(transfer.fd);
    try {
      renameAt(transfer.dirFd, partOf(id), transfer.name);
      return result("home_result", id);
    } catch {
      try {
        unlinkAt(transfer.dirFd, partOf(id));
      } catch {
        // already gone
      }
      return result("home_result", id, "write_failed");
    } finally {
      closeQuietly(transfer.dirFd);
    }
  };

  const write = (chunk: HomePut): HomeResult => {
    const known = transfers.get(chunk.id);
    if (known === undefined && chunk.offset !== 0) return result("home_result", chunk.id, "order");
    if (known !== undefined && (chunk.offset !== known.written || chunk.path !== known.path)) {
      abandon(chunk.id);
      return result("home_result", chunk.id, "order");
    }
    const transfer = known ?? begin(chunk);
    const bytes = Buffer.from(chunk.data, "base64");
    if (transfer.written + bytes.length > AGENT_FILE_LIMITS.maxBytes) {
      abandon(chunk.id);
      return result("home_result", chunk.id, "too_large");
    }
    for (let done = 0; done < bytes.length;) done += writeSync(transfer.fd, bytes, done, bytes.length - done);
    transfer.written += bytes.length;
    return chunk.last ? finish(chunk.id, transfer) : result("home_result", chunk.id);
  };

  return {
    put(chunk) {
      try {
        return Promise.resolve(write(chunk));
      } catch {
        abandon(chunk.id);
        return Promise.resolve(result("home_result", chunk.id, "write_failed"));
      }
    },
    remove(request) {
      try {
        const segments = segmentsOf(request.path);
        const name = segments[segments.length - 1] as string;
        let dirFd: number;
        try {
          dirFd = openParent(segments.slice(0, -1), false);
        } catch (error) {
          if (codeOf(error) === "ENOENT") return Promise.resolve(result("home_result", request.id));
          throw error;
        }
        try {
          unlinkAt(dirFd, name);
        } catch (error) {
          if (codeOf(error) !== "ENOENT") throw error;
        } finally {
          closeQuietly(dirFd);
        }
        return Promise.resolve(result("home_result", request.id));
      } catch {
        return Promise.resolve(result("home_result", request.id, "write_failed"));
      }
    },
  };
}
