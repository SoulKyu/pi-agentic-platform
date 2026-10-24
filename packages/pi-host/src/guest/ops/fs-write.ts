import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, writeSync } from "node:fs";
import { FILE_LIMITS, PAGE_BYTES, sizeOf } from "@pap/contracts";
import { linkAt, openAt, renameAt, unlinkAt } from "../../nofollow.ts";
import { etagOf, readAt } from "./fs-read.ts";
import { OpError, type OpEnv, opErrorOf, segmentsOf, withFolder, withParent } from "./paths.ts";

const NEW_FILE_MODE = 0o644;
const TEMP_NAME = /^\.pap-[0-9a-f]{12}\.tmp$/;
const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/** A path `fs.*` may write: no component is `.git` (the entry itself, or anything below it, at any level), and the name is not a temporary one. */
function writable(segments: readonly string[]): void {
  const name = segments[segments.length - 1] ?? "";
  if (segments.some((segment) => segment.normalize("NFC").toLowerCase() === ".git") || TEMP_NAME.test(name)) {
    throw new OpError("bad_request");
  }
}

/** The mode of the regular file `name` in `parent` and its first `max + 1` bytes, or null when it is not there. */
function existing(parent: number, name: string, max: number): { mode: number; body: Buffer } | null {
  let fd: number;
  try {
    fd = openAt(parent, name, constants.O_RDONLY);
  } catch (error) {
    if (errno(error) === "ENOENT") return null;
    throw error;
  }
  try {
    return { mode: fstatSync(fd).mode & 0o7777, body: readAt(fd, 0, max + 1) };
  } finally {
    closeSync(fd);
  }
}

function newTemp(parent: number): { name: string; fd: number } {
  const name = `.pap-${randomBytes(6).toString("hex")}.tmp`;
  return { name, fd: openAt(parent, name, CREATE, 0o600) };
}

function writeAll(fd: number, bytes: Uint8Array): void {
  for (let done = 0; done < bytes.length;) done += writeSync(fd, bytes, done);
}

/** Puts a finished temporary file in place: replacing the target, or only when nothing is there (`false`: something is). */
function place(parent: number, temp: string, name: string, replace: boolean): boolean {
  if (replace) {
    renameAt(parent, temp, name);
    return true;
  }
  try {
    linkAt(parent, temp, name);
  } catch (error) {
    if (errno(error) === "EEXIST") return false;
    throw error;
  }
  unlinkAt(parent, temp);
  return true;
}

function dropTemp(parent: number, temp: string): void {
  try {
    unlinkAt(parent, temp);
  } catch {
    // already renamed or never made
  }
}

/** `fs.write` (the host's `files.write`): the etag check, then one atomic replace or exclusive creation. */
export function fsWrite(
  env: OpEnv,
  args: { readonly path: string; readonly text: string; readonly baseEtag: string | null },
): { etag: string } {
  const bytes = Buffer.from(args.text, "utf8");
  if (bytes.length > FILE_LIMITS.editableBytes || sizeOf(args.text) > PAGE_BYTES) {
    throw new OpError("payload_too_large");
  }
  writable(segmentsOf(env.project, args.path));
  return withParent(env, args.path, (parent, name) => {
    const current = existing(parent, name, FILE_LIMITS.editableBytes);
    if (current !== null) {
      const same =
        args.baseEtag !== null &&
        current.body.length <= FILE_LIMITS.editableBytes &&
        etagOf(current.body) === args.baseEtag;
      if (!same) throw new OpError("conflict");
    } else if (args.baseEtag !== null) throw new OpError("conflict");
    const temp = newTemp(parent);
    try {
      writeAll(temp.fd, bytes);
      fchmodSync(temp.fd, current?.mode ?? NEW_FILE_MODE);
      fsyncSync(temp.fd);
      closeSync(temp.fd);
      temp.fd = -1;
      if (!place(parent, temp.name, name, current !== null)) throw new OpError("conflict");
    } catch (error) {
      if (temp.fd >= 0) closeSync(temp.fd);
      dropTemp(parent, temp.name);
      throw opErrorOf(error);
    }
    return { etag: etagOf(bytes) };
  });
}

/** An upload in progress: its temporary file sits next to the target until the last chunk. */
interface Upload {
  readonly path: string;
  readonly conflict: "skip" | "replace";
  readonly parentSegments: readonly string[];
  readonly name: string;
  readonly temp: string;
  fd: number;
  received: number;
  touched: number;
}

const UPLOADS_MAX = 8;
/** A transfer that has not moved for this long is dropped, its temporary file with it. */
const UPLOAD_IDLE_MS = 5 * 60_000;

export interface PutArgs {
  readonly id: string;
  readonly path: string;
  readonly offset: number;
  readonly data: string;
  readonly last: boolean;
  readonly conflict: "skip" | "replace";
}

export interface Uploads {
  /** One chunk of an upload (the host's `PUT /files/raw`): in order, the first at offset 0, `last` places the file. */
  put(env: OpEnv, args: PutArgs): { done: boolean; skipped: boolean };
}

export function createUploads(): Uploads {
  const open = new Map<string, Upload>();

  const release = (env: OpEnv, id: string): void => {
    const upload = open.get(id);
    if (!upload) return;
    open.delete(id);
    if (upload.fd >= 0) closeSync(upload.fd);
    try {
      withFolder(env.project, upload.parentSegments, (parent) => dropTemp(parent, upload.temp));
    } catch {
      // the folder is gone, and its temporary file with it
    }
  };

  const begin = (env: OpEnv, args: PutArgs): Upload | "skipped" => {
    writable(segmentsOf(env.project, args.path));
    return withParent(env, args.path, (parent, name, segments) => {
      const parentSegments = segments.slice(0, -1);
      if (args.conflict === "skip" && existing(parent, name, 0) !== null) return "skipped";
      const temp = newTemp(parent);
      return {
        path: args.path,
        conflict: args.conflict,
        parentSegments,
        name,
        temp: temp.name,
        fd: temp.fd,
        received: 0,
        touched: env.now(),
      };
    });
  };

  const finish = (env: OpEnv, id: string, upload: Upload): { done: boolean; skipped: boolean } => {
    fsyncSync(upload.fd);
    const placed = withFolder(env.project, upload.parentSegments, (parent) => {
      const current = existing(parent, upload.name, 0);
      if (current !== null && upload.conflict === "skip") return false;
      fchmodSync(upload.fd, current?.mode ?? NEW_FILE_MODE);
      closeSync(upload.fd);
      upload.fd = -1;
      return place(parent, upload.temp, upload.name, current !== null);
    });
    release(env, id);
    if (!placed && upload.conflict === "replace") throw new OpError("conflict");
    return { done: true, skipped: !placed };
  };

  return {
    put(env, args) {
      for (const [id, upload] of open) if (env.now() - upload.touched > UPLOAD_IDLE_MS) release(env, id);
      let upload = open.get(args.id);
      try {
        if (upload === undefined) {
          if (args.offset !== 0) throw new OpError("bad_request");
          if (open.size >= UPLOADS_MAX) throw new OpError("payload_too_large");
          const started = begin(env, args);
          if (started === "skipped") return { done: true, skipped: true };
          upload = started;
          open.set(args.id, upload);
        }
        const bytes = Buffer.from(args.data, "base64");
        if (upload.path !== args.path || upload.received !== args.offset) throw new OpError("bad_request");
        if (upload.received + bytes.length > FILE_LIMITS.uploadBytes) throw new OpError("payload_too_large");
        writeAll(upload.fd, bytes);
        upload.received += bytes.length;
        upload.touched = env.now();
        return args.last ? finish(env, args.id, upload) : { done: false, skipped: false };
      } catch (error) {
        release(env, args.id);
        throw opErrorOf(error);
      }
    },
  };
}
