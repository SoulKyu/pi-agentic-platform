import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  FILE_CHUNK_BYTES,
  FILE_LIMITS,
  type FilePutResult,
  PapError,
  type PromptImageRef,
} from "@pap/contracts";
import type { z } from "zod";
import type { Clock } from "../../kernel/clock.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import type { AttachmentsPort } from "../files/index.ts";

type ClaimedAttachments = Awaited<ReturnType<AttachmentsPort["claim"]>>;

/** A chunk the worker has not answered after this long is lost: the prompt fails instead of waiting for ever. */
export const FILE_PUT_TIMEOUT_MS = 30_000;
const NAME_MAX = 128;
/** `-` and four hex digits, put before the extension when the name exists already. */
const SUFFIX_CHARS = 5;
type PutResult = z.infer<typeof FilePutResult>;

/** Where a VM session's attachments go: its worker's handle and the VM's inbox folder. Set when the session starts. */
export interface VmTarget {
  readonly handle: WorkerHandle;
  readonly inbox: string;
  readonly clock: Clock;
}
/** Keyed by the live session; a host session has no entry (R33 applies to VM agents only). */
export const vmTargets = new WeakMap<object, VmTarget>();

const refused = (): PapError => new PapError("prompt_rejected");

/** A name the worker's schema accepts (`FilePut.name`): accents folded, anything else `_`, a letter or digit first, 128 at most. */
export function inboxName(raw: string): string {
  let name = raw
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^A-Za-z0-9._-]/g, "_");
  if (!/^[A-Za-z0-9]/.test(name)) name = `f${name}`;
  if (name.length > NAME_MAX) {
    const ext = /\.[A-Za-z0-9]{1,16}$/.exec(name)?.[0] ?? "";
    name = `${name.slice(0, NAME_MAX - ext.length)}${ext}`;
  }
  return name;
}

/** `report.tar.gz` becomes `report.tar-1f2e.gz`: still within the schema, the extension kept. */
function suffixed(name: string): string {
  const dot = name.lastIndexOf(".");
  const at = dot > 0 ? dot : name.length;
  const ext = name.slice(at);
  const stem = name.slice(0, Math.min(at, NAME_MAX - SUFFIX_CHARS - ext.length));
  return `${stem}-${randomBytes(2).toString("hex")}${ext}`;
}

/**
 * Sends the files into the VM's inbox, one at a time, in chunks of `FILE_CHUNK_BYTES` (R33). The next chunk goes out when the
 * worker has answered the one before, so the wire's backlog stays at one chunk. A name that exists in the inbox is retried once
 * under another name. Returns the VM paths, in order. Any failure is `prompt_rejected`: the worker is never crashed by it.
 */
export async function putAttachments(
  handle: WorkerHandle,
  files: ReadonlyArray<{ readonly name: string; readonly bytes: Buffer }>,
  options: { readonly inbox: string; readonly clock: Clock },
): Promise<string[]> {
  if (files.some((file) => file.bytes.length > FILE_LIMITS.uploadBytes)) throw refused();
  const { clock } = options;
  let gone = false;
  let abort: (() => void) | undefined;
  void handle.exited.then(() => {
    gone = true;
    abort?.();
  });

  const chunk = (frame: {
    id: string;
    name: string;
    offset: number;
    data: string;
    last: boolean;
  }): Promise<PutResult> =>
    new Promise<PutResult>((resolve, reject) => {
      if (gone) return reject(refused());
      let off: () => void = () => {};
      const timer = clock.setTimeout(() => settle(refused()), FILE_PUT_TIMEOUT_MS);
      const settle = (outcome: PutResult | PapError): void => {
        off();
        clock.clearTimeout(timer);
        abort = undefined;
        if (outcome instanceof PapError) reject(outcome);
        else resolve(outcome);
      };
      abort = () => settle(refused());
      off = handle.onRecord((record) => {
        if (record.type === "file_put_result" && record.id === frame.id) settle(record);
      });
      if (!handle.send({ type: "file_put", ...frame })) settle(refused());
    });

  /** The code of the failure, or null once the final name appeared. */
  async function sendFile(name: string, bytes: Buffer): Promise<string | null> {
    const id = randomBytes(16).toString("hex");
    let offset = 0;
    for (;;) {
      const end = Math.min(offset + FILE_CHUNK_BYTES, bytes.length);
      const last = end >= bytes.length;
      const result = await chunk({
        id,
        name,
        offset,
        data: bytes.subarray(offset, end).toString("base64"),
        last,
      });
      if (!result.ok) return result.code ?? "write_failed";
      if (last) return null;
      offset = end;
    }
  }

  const paths: string[] = [];
  for (const file of files) {
    let name = inboxName(file.name);
    let failure = await sendFile(name, file.bytes);
    if (failure === "exists") {
      name = suffixed(name);
      failure = await sendFile(name, file.bytes);
    }
    if (failure !== null) throw refused();
    paths.push(`${options.inbox}/${name}`);
  }
  return paths;
}

/** At most `FILE_LIMITS.uploadBytes`, from a regular file that is not a link (O_NOFOLLOW, one name), read through its descriptor. */
async function readBounded(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
    () => {
      throw refused();
    },
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > FILE_LIMITS.uploadBytes) throw refused();
    const bytes = Buffer.alloc(info.size);
    let read = 0;
    while (read < bytes.length) {
      const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return bytes.subarray(0, read);
  } finally {
    await handle.close();
  }
}

/**
 * What a prompt sends to a VM agent in place of host paths: the claimed uploads are read here, put into the inbox, and the
 * message and the image refs name `inbox/<name>`. A host path never reaches the VM worker (T8b).
 */
export function vmDelivery(
  text: string,
  claimed: ClaimedAttachments,
  announce: (text: string, paths: readonly string[]) => string,
) {
  return async (
    target: VmTarget,
  ): Promise<{ readonly text: string; readonly images: readonly PromptImageRef[] | undefined }> => {
    const options = { inbox: target.inbox, clock: target.clock };
    const put = async (name: string, path: string): Promise<string> =>
      (await putAttachments(target.handle, [{ name, bytes: await readBounded(path) }], options))[0] ?? "";
    const images: PromptImageRef[] = [];
    for (const image of claimed.images) {
      const extension = image.mimeType.split("/")[1] ?? "img";
      images.push({
        path: await put(`image-${image.id.slice(0, 8)}.${extension}`, image.path),
        mimeType: image.mimeType,
      });
    }
    const paths: string[] = [];
    for (const file of claimed.files) paths.push(await put(file.name, file.path));
    return { text: announce(text, paths), images: images.length === 0 ? undefined : images };
  };
}
