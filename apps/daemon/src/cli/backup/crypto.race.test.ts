import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptFile, encryptStream } from "./crypto.ts";

/**
 * The ciphertext is read once to authenticate and once to write. This lets a test change what a pass reads, make a
 * read fail, make the output fail, and see whether the output exists when a pass starts.
 */
const state = {
  reads: 0,
  tamperOn: 0,
  failReadOn: 0,
  failWrite: false,
  watch: "",
  outExistedAtRead: [] as boolean[],
  lastByte: -1,
};
const HEADER = 37;
type ReadDone = (error: Error | null, bytes: number, buffer: Buffer) => void;
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => {
      if (!state.failWrite) return actual.createWriteStream(...args);
      const fd = (args[1] as { fd: number }).fd;
      let closed = false;
      return new Writable({
        write: (_chunk, _encoding, done) => done(Object.assign(new Error("disk full"), { code: "ENOSPC" })),
        destroy: (error, done) => {
          if (!closed) actual.closeSync(fd);
          closed = true;
          done(error);
        },
      }) as never;
    },
    // One ciphertext pass starts at the first byte after the header (position 37).
    read: (fd: number, buffer: Buffer, offset: number, length: number, position: number, done: ReadDone) => {
      if (position === HEADER) {
        state.reads += 1;
        if (state.watch !== "") state.outExistedAtRead.push(actual.existsSync(state.watch));
      }
      if (state.reads === state.failReadOn) {
        done(Object.assign(new Error("io"), { code: "EIO" }), 0, buffer);
        return;
      }
      actual.read(fd, buffer, offset, length, position, (error, bytes, filled) => {
        const last = position + bytes - 1 === state.lastByte;
        if (!error && state.reads === state.tamperOn && last)
          filled[bytes - 1] = (filled[bytes - 1] ?? 0) ^ 0x01;
        done(error, bytes, filled);
      });
    },
  };
});

const PASSPHRASE = "correct horse battery";
const CHANGED = "wrong passphrase, or the backup was changed or damaged";
let dir: string;
let file: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pap-crypto-race-"));
  file = join(dir, "backup.enc");
  Object.assign(state, {
    reads: 0,
    tamperOn: 0,
    failReadOn: 0,
    failWrite: false,
    watch: "",
    outExistedAtRead: [],
  });
  await encryptStream(Readable.from([randomBytes(200_000)]), file, PASSPHRASE);
  state.reads = 0;
  state.lastByte = statSync(file).size - 16 - 1;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("decryptFile authenticates before it writes", () => {
  it("creates the output only after the first pass has authenticated the whole file", async () => {
    const out = join(dir, "plain");
    state.watch = out;
    await decryptFile(file, out, PASSPHRASE);
    expect(state.outExistedAtRead).toEqual([false, true]);
  });

  it("creates no output at all when the first pass fails", async () => {
    state.tamperOn = 1;
    await expect(decryptFile(file, join(dir, "plain"), PASSPHRASE)).rejects.toThrow(CHANGED);
    expect(readdirSync(dir)).toEqual(["backup.enc"]);
  });

  it("says the file changed, and removes the output, when it changes between the two passes", async () => {
    state.tamperOn = 2;
    await expect(decryptFile(file, join(dir, "plain"), PASSPHRASE)).rejects.toThrow(
      "the backup changed while it was being decrypted",
    );
    expect(readdirSync(dir)).toEqual(["backup.enc"]);
  });
});

describe("decryptFile tells a failing disk from a bad backup", () => {
  it("reports a failing output as a write error with its code, and removes the output", async () => {
    state.failWrite = true;
    await expect(decryptFile(file, join(dir, "plain"), PASSPHRASE)).rejects.toThrow(
      "the decrypted archive could not be written: ENOSPC",
    );
    expect(readdirSync(dir)).toEqual(["backup.enc"]);
  });

  it.each([1, 2])("reports a failing read in pass %i as a read error with its code", async (pass) => {
    state.failReadOn = pass;
    await expect(decryptFile(file, join(dir, "plain"), PASSPHRASE)).rejects.toThrow(
      "the backup could not be read: EIO",
    );
    expect(readdirSync(dir)).toEqual(["backup.enc"]);
  });
});
