import { closeSync, constants, fchmodSync, writeSync } from "node:fs";
import { FILE_LIMITS, FilePut as FilePutSchema, FilePutResult as FilePutResultSchema } from "@pap/contracts";
import type { z } from "zod";
import { closeQuietly, linkAt, openAt, openRootDir, unlinkAt } from "./nofollow.ts";

/**
 * Attachments of a worker in a VM (R33, RT-15): the daemon sends a file as ordered chunks; each lands in a temporary part
 * file of the agent's inbox and gets its name at `last`. The agent owns the inbox and may plant links in it, so the part
 * is opened exclusively and without following a link, and the name is taken with a no-replace link (AVM-P7, AVM-E13):
 * a name that exists in any form, a link included, is never overwritten and never followed.
 */

export type FilePut = z.infer<typeof FilePutSchema>;
export type FilePutResult = z.infer<typeof FilePutResultSchema>;

interface Transfer {
  readonly fd: number;
  readonly dirFd: number;
  readonly name: string;
  written: number;
}

const partOf = (id: string): string => `.${id}.part`;
const result = (id: string, code?: NonNullable<FilePutResult["code"]>): FilePutResult =>
  code === undefined
    ? { type: "file_put_result", id, ok: true }
    : { type: "file_put_result", id, ok: false, code };

export function createInbox(inbox: string): { put(chunk: FilePut): FilePutResult } {
  const transfers = new Map<string, Transfer>();

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

  const begin = (id: string, name: string): Transfer => {
    const dirFd = openRootDir(inbox);
    try {
      const fd = openAt(dirFd, partOf(id), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
      fchmodSync(fd, 0o644);
      const transfer = { fd, dirFd, name, written: 0 };
      transfers.set(id, transfer);
      return transfer;
    } catch (error) {
      closeQuietly(dirFd);
      throw error;
    }
  };

  const finish = (id: string, transfer: Transfer): FilePutResult => {
    transfers.delete(id);
    closeSync(transfer.fd);
    try {
      linkAt(transfer.dirFd, partOf(id), transfer.name);
      return result(id);
    } catch (error) {
      return result(id, (error as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "write_failed");
    } finally {
      try {
        unlinkAt(transfer.dirFd, partOf(id));
      } catch {
        // already gone
      }
      closeQuietly(transfer.dirFd);
    }
  };

  const write = (chunk: FilePut): FilePutResult | null => {
    const known = transfers.get(chunk.id);
    if (known === undefined && chunk.offset !== 0) return result(chunk.id, "order");
    if (known !== undefined && chunk.offset !== known.written) {
      abandon(chunk.id);
      return result(chunk.id, "order");
    }
    // An unknown id at offset 0 starts a transfer; a known one at offset 0 has written nothing yet.
    const transfer = known ?? begin(chunk.id, chunk.name);
    const bytes = Buffer.from(chunk.data, "base64");
    if (transfer.written + bytes.length > FILE_LIMITS.uploadBytes) {
      abandon(chunk.id);
      return result(chunk.id, "too_large");
    }
    for (let done = 0; done < bytes.length;) done += writeSync(transfer.fd, bytes, done, bytes.length - done);
    transfer.written += bytes.length;
    // Every chunk is answered (J1): the daemon sends the next one only after the answer, so the wire's backlog stays at one chunk.
    return chunk.last ? finish(chunk.id, transfer) : result(chunk.id);
  };

  return {
    put(chunk) {
      try {
        return write(chunk);
      } catch {
        abandon(chunk.id);
        return result(chunk.id, "write_failed");
      }
    },
  };
}
