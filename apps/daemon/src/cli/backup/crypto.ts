import { createCipheriv, createDecipheriv, randomBytes, scrypt, type CipherGCM } from "node:crypto";
import {
  closeSync,
  constants,
  createWriteStream,
  fstatSync,
  openSync,
  read,
  readSync,
  rmSync,
} from "node:fs";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** `PAPB1\n`, the scrypt cost (log2 N, r, p), the salt and the IV; the whole header is the GCM additional data. */
const MAGIC = Buffer.from("PAPB1\n", "latin1");
const SALT = 16;
const IV = 12;
const TAG = 16;
const HEADER = MAGIC.length + 3 + SALT + IV;
const LOG2_N = 17;
const R = 8;
const P = 1;
/** A header names its own cost before anything authenticates it: bound it, or a forged file costs seconds of CPU and 256 MiB. */
const MAX_LOG2_N = 18;
const MIN_LOG2_N = 14;
/** scrypt needs 128 * N * r bytes plus a little: 256 MiB at the largest accepted cost. */
const SCRYPT_MAXMEM = 512 * 1024 * 1024;
export const MIN_PASSPHRASE = 12;

const NOT_A_BACKUP = "not a pap encrypted backup";
const NOT_A_FILE = "the backup path is not a regular file";
const SWAPPED = "the backup changed while it was being decrypted";
const CHANGED = "wrong passphrase, or the backup was changed or damaged";

export class BackupCryptoError extends Error {
  override name = "BackupCryptoError";
}

const normalized = (passphrase: string): string => passphrase.normalize("NFKC");

/** Counted in characters after NFKC, so the composed and the decomposed spelling of a text weigh the same. */
export const passphraseTooShort = (passphrase: string): boolean =>
  [...normalized(passphrase)].length < MIN_PASSPHRASE;

/** The key is the caller's to `.fill(0)`; the passphrase bytes are zeroed here (a JS string cannot be). */
const derive = (passphrase: string, salt: Buffer, log2n: number, r: number, p: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const secret = Buffer.from(normalized(passphrase), "utf8");
    scrypt(secret, salt, 32, { N: 2 ** log2n, r, p, maxmem: SCRYPT_MAXMEM }, (error, key) => {
      secret.fill(0);
      if (error) reject(new BackupCryptoError("key derivation failed"));
      else resolve(key);
    });
  });

/**
 * Encrypts `plain` into `outPath` (mode 0600, `wx`: never over an existing file). The tag is the last 16 bytes.
 * `plain` is consumed from the first line on: a child's stdout that nobody reads when the child exits is dropped by
 * Node, so the key derivation (about 0.4 s) happens inside the pipeline, not before it.
 */
export async function encryptStream(plain: Readable, outPath: string, passphrase: string): Promise<void> {
  if (passphraseTooShort(passphrase)) {
    plain.destroy();
    throw new BackupCryptoError(`the passphrase needs at least ${MIN_PASSPHRASE} characters`);
  }
  const salt = randomBytes(SALT);
  const iv = randomBytes(IV);
  const header = Buffer.concat([MAGIC, Buffer.from([LOG2_N, R, P]), salt, iv]);
  let fd: number;
  try {
    // Created before any byte is written, so a failure below only ever removes our own file.
    fd = openSync(outPath, "wx", 0o600);
  } catch (error) {
    plain.destroy(); // nothing will read the producer: let it stop instead of blocking on a full pipe
    throw error;
  }
  const key = derive(passphrase, salt, LOG2_N, R, P);
  key.catch(() => undefined); // surfaced by the stage below; this only keeps an early failure from being unhandled
  let cipher: CipherGCM;
  const stage = new Transform({
    writableHighWaterMark: 1024 * 1024,
    construct(done) {
      key.then((derived) => {
        cipher = createCipheriv("aes-256-gcm", derived, iv, { authTagLength: TAG });
        derived.fill(0);
        cipher.setAAD(header);
        done();
      }, done);
    },
    transform(chunk: Buffer, _encoding, done) {
      done(null, cipher.update(chunk));
    },
    flush(done) {
      done(null, Buffer.concat([cipher.final(), cipher.getAuthTag()]));
    },
  });
  const out = createWriteStream(outPath, { fd });
  out.write(header);
  try {
    await pipeline(plain, stage, out);
  } catch (error) {
    out.destroy();
    rmSync(outPath, { force: true });
    throw error;
  }
}

/** The bytes `start..end` of `fd`, read by position: the descriptor stays the caller's, whatever happens to the stream. */
function range(fd: number, start: number, end: number): Readable {
  let position = start;
  return new Readable({
    highWaterMark: 64 * 1024,
    read(size) {
      if (position > end) {
        this.push(null);
        return;
      }
      const buffer = Buffer.allocUnsafe(Math.min(size, end - position + 1));
      read(fd, buffer, 0, buffer.length, position, (error, bytes) => {
        if (error) this.destroy(error);
        else if (bytes === 0) this.destroy(Object.assign(new Error("short read"), { code: "EOF" }));
        else {
          position += bytes;
          this.push(buffer.subarray(0, bytes));
        }
      });
    },
  });
}

const discard = (): Writable =>
  new Writable({
    write: (_chunk, _encoding, done) => done(),
  });

type Where = "read" | "authentication" | "write";

/** One pass over the ciphertext; the first stream to fail says where, so a full disk is not reported as a bad file. */
async function pass(source: Readable, decipher: Transform, sink: Writable): Promise<void> {
  let failed: { where: Where; error: Error } | undefined;
  const watch = (stream: Readable | Transform | Writable, where: Where) =>
    stream.once("error", (error: Error) => {
      failed ??= { where, error };
    });
  watch(source, "read");
  watch(decipher, "authentication");
  watch(sink, "write");
  try {
    await pipeline(source, decipher, sink);
  } catch {
    const code = (failed?.error as NodeJS.ErrnoException | undefined)?.code ?? "error";
    if (failed?.where === "authentication") throw new AuthenticationFailed();
    if (failed === undefined || failed.where === "read")
      throw new BackupCryptoError(`the backup could not be read: ${code}`);
    throw new BackupCryptoError(`the decrypted archive could not be written: ${code}`);
  }
}

class AuthenticationFailed extends Error {}

/**
 * Decrypts `inPath` into `outPath` (0600, `wx`). One descriptor serves both passes (no symbolic link, no FIFO, only a
 * regular file). The ciphertext is read twice: the first pass only authenticates, so a wrong passphrase or a changed
 * file is refused before `outPath` exists; the second pass writes (and authenticates again, in case the file changed
 * in between). Nothing from a file that fails authentication stays on disk.
 */
export async function decryptFile(inPath: string, outPath: string, passphrase: string): Promise<void> {
  let fd: number;
  try {
    // O_NONBLOCK: opening a FIFO must not wait for a writer.
    fd = openSync(inPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new BackupCryptoError(NOT_A_FILE);
    throw error;
  }
  let key: Buffer | undefined;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new BackupCryptoError(NOT_A_FILE);
    const size = stat.size;
    if (size < HEADER + TAG) throw new BackupCryptoError(NOT_A_BACKUP);
    const header = Buffer.alloc(HEADER);
    readSync(fd, header, 0, HEADER, 0);
    const tag = Buffer.alloc(TAG);
    readSync(fd, tag, 0, TAG, size - TAG);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupCryptoError(NOT_A_BACKUP);
    const [log2n = 0, r = 0, p = 0] = header.subarray(MAGIC.length, MAGIC.length + 3);
    if (log2n < MIN_LOG2_N || log2n > MAX_LOG2_N || r !== R || p !== P)
      throw new BackupCryptoError(NOT_A_BACKUP);
    const salt = header.subarray(MAGIC.length + 3, MAGIC.length + 3 + SALT);
    const iv = header.subarray(MAGIC.length + 3 + SALT);
    const derived = await derive(passphrase, salt, log2n, r, p);
    key = derived;
    const decipher = () => {
      const stream = createDecipheriv("aes-256-gcm", derived, iv, { authTagLength: TAG });
      stream.setAAD(header);
      stream.setAuthTag(tag);
      return stream;
    };
    // An empty message is valid GCM, and a read range of zero bytes is not.
    const ciphertext = (): Readable =>
      size === HEADER + TAG ? Readable.from([]) : range(fd, HEADER, size - TAG - 1);

    // GCM reports a wrong passphrase and a changed file the same way, by design: the message says both.
    try {
      await pass(ciphertext(), decipher(), discard());
    } catch (error) {
      if (error instanceof AuthenticationFailed) throw new BackupCryptoError(CHANGED);
      throw error;
    }
    const outFd = openSync(outPath, "wx", 0o600);
    try {
      await pass(ciphertext(), decipher(), createWriteStream(outPath, { fd: outFd }));
    } catch (error) {
      rmSync(outPath, { force: true });
      if (error instanceof AuthenticationFailed) throw new BackupCryptoError(SWAPPED);
      throw error;
    }
  } finally {
    key?.fill(0);
    closeSync(fd);
  }
}
