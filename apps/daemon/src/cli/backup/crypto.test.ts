import { execFileSync, spawn } from "node:child_process";
import { createCipheriv, randomBytes, scrypt } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupCryptoError, decryptFile, encryptStream, MIN_PASSPHRASE } from "./crypto.ts";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, scrypt: vi.fn(actual.scrypt) };
});
const scryptSpy = vi.mocked(scrypt);
const actualScrypt = (await vi.importActual<typeof import("node:crypto")>("node:crypto")).scrypt;

const PASSPHRASE = "correct horse battery";
const BAD = "not a pap encrypted backup";
const CHANGED = "wrong passphrase, or the backup was changed or damaged";
const MAGIC = Buffer.from("PAPB1\n", "latin1");
const HEADER = MAGIC.length + 3 + 16 + 12;

let dir: string;
let plain: Buffer;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-crypto-"));
  plain = randomBytes(3 * 1024 * 1024);
  scryptSpy.mockClear();
});
afterEach(() => {
  scryptSpy.mockReset();
  scryptSpy.mockImplementation(actualScrypt as never);
  rmSync(dir, { recursive: true, force: true });
});

const chunks = (buffer: Buffer): Readable => Readable.from([buffer.subarray(0, 1000), buffer.subarray(1000)]);
const names = (): string[] => readdirSync(dir).sort();

async function sealed(): Promise<string> {
  const file = join(dir, "backup.enc");
  await encryptStream(chunks(plain), file, PASSPHRASE);
  return file;
}

/** Builds a container like the format says, with a chosen cost and an optional additional-data choice. */
async function craft(
  input: Buffer,
  options: { log2n?: number; r?: number; p?: number; aad?: boolean; passphrase?: string } = {},
): Promise<string> {
  const { log2n = 17, r = 8, p = 1, aad = true, passphrase = PASSPHRASE } = options;
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header = Buffer.concat([MAGIC, Buffer.from([log2n, r, p]), salt, iv]);
  const key = await new Promise<Buffer>((resolve, reject) =>
    actualScrypt(
      Buffer.from(passphrase, "utf8"),
      salt,
      32,
      { N: 2 ** Math.min(log2n, 18), r: 8, p: 1, maxmem: 512 * 1024 * 1024 },
      (error, derived) => (error ? reject(error) : resolve(derived)),
    ),
  );
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  if (aad) cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(input), cipher.final()]);
  const file = join(dir, `crafted-${log2n}-${r}-${p}-${aad}.enc`);
  writeFileSync(file, Buffer.concat([header, body, cipher.getAuthTag()]));
  return file;
}

const flip = (file: string, offset: number): void => {
  const bytes = readFileSync(file);
  bytes[offset] = (bytes[offset] ?? 0) ^ 0x01;
  writeFileSync(file, bytes);
};

describe("encryptStream and decryptFile", () => {
  it("round-trips 3 MB byte for byte, both files 0600, and hides the content", async () => {
    const file = await sealed();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const container = readFileSync(file);
    expect(container.subarray(0, MAGIC.length).equals(MAGIC)).toBe(true);
    expect([...container.subarray(MAGIC.length, MAGIC.length + 3)]).toEqual([17, 8, 1]);
    expect(container.length).toBe(HEADER + plain.length + 16);
    expect(container.includes(plain.subarray(100, 164))).toBe(false);
    const out = join(dir, "plain.tar.gz");
    await decryptFile(file, out, PASSPHRASE);
    expect(readFileSync(out).equals(plain)).toBe(true);
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it("round-trips an empty message", async () => {
    const file = join(dir, "empty.enc");
    await encryptStream(Readable.from([]), file, PASSPHRASE);
    expect(statSync(file).size).toBe(HEADER + 16);
    const out = join(dir, "empty.out");
    await decryptFile(file, out, PASSPHRASE);
    expect(readFileSync(out).length).toBe(0);
  });

  it("keeps the output of a child process that exits while the key is being derived", async () => {
    const child = spawn(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000))"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const file = join(dir, "child.enc");
    await encryptStream(child.stdout, file, PASSPHRASE);
    const out = join(dir, "child.out");
    await decryptFile(file, out, PASSPHRASE);
    expect(readFileSync(out, "utf8")).toBe("x".repeat(100000));
  });

  it("gives a fresh salt and IV each time", async () => {
    const a = join(dir, "a.enc");
    const b = join(dir, "b.enc");
    await encryptStream(chunks(plain), a, PASSPHRASE);
    await encryptStream(chunks(plain), b, PASSPHRASE);
    expect(readFileSync(a).subarray(9, HEADER).equals(readFileSync(b).subarray(9, HEADER))).toBe(false);
  });

  it("refuses a wrong passphrase and a flipped ciphertext byte with the same message, writing nothing", async () => {
    const file = await sealed();
    const out = join(dir, "plain.tar.gz");
    await expect(decryptFile(file, out, "another passphrase!")).rejects.toThrow(CHANGED);
    flip(file, HEADER + 1_000_000);
    await expect(decryptFile(file, out, PASSPHRASE)).rejects.toThrow(CHANGED);
    expect(names()).toEqual(["backup.enc"]);
  });

  it("refuses a flipped byte in the tag, the salt, the IV and the cost field, writing nothing", async () => {
    const out = join(dir, "plain.tar.gz");
    for (const offset of [6, 9, 9 + 16 + 3]) {
      const file = await sealed();
      flip(file, offset);
      await expect(decryptFile(file, out, PASSPHRASE)).rejects.toThrow(CHANGED);
      rmSync(file);
    }
    const file = await sealed();
    flip(file, statSync(file).size - 1);
    await expect(decryptFile(file, out, PASSPHRASE)).rejects.toThrow(CHANGED);
    expect(names()).toEqual(["backup.enc"]);
  });

  it("binds the header as additional data: a file sealed without it is refused", async () => {
    const out = join(dir, "plain.tar.gz");
    const withoutAad = await craft(plain.subarray(0, 5000), { aad: false });
    await expect(decryptFile(withoutAad, out, PASSPHRASE)).rejects.toThrow(CHANGED);
    const withAad = await craft(plain.subarray(0, 5000));
    await decryptFile(withAad, out, PASSPHRASE);
    expect(readFileSync(out).equals(plain.subarray(0, 5000))).toBe(true);
  });

  it("refuses a file cut inside the tag or inside the ciphertext", async () => {
    const out = join(dir, "plain.tar.gz");
    for (const cut of [5, 1000]) {
      const file = await sealed();
      const bytes = readFileSync(file);
      writeFileSync(file, bytes.subarray(0, bytes.length - cut));
      await expect(decryptFile(file, out, PASSPHRASE)).rejects.toThrow(CHANGED);
      rmSync(file);
    }
    expect(names()).toEqual([]);
  });

  it("says what it is when the file is too short or is not a container", async () => {
    const out = join(dir, "plain.tar.gz");
    const short = join(dir, "short.enc");
    writeFileSync(short, Buffer.alloc(HEADER + 16 - 1, 1));
    await expect(decryptFile(short, out, PASSPHRASE)).rejects.toThrow(BAD);
    const other = join(dir, "other.enc");
    writeFileSync(other, randomBytes(4096));
    await expect(decryptFile(other, out, PASSPHRASE)).rejects.toThrow(BAD);
    const magic = await sealed();
    flip(magic, 0);
    scryptSpy.mockClear();
    await expect(decryptFile(magic, out, PASSPHRASE)).rejects.toThrow(BAD);
    expect(scryptSpy).not.toHaveBeenCalled();
    expect(names()).toEqual(["backup.enc", "other.enc", "short.enc"]);
  });

  it.each([
    ["13 (below the range)", 13, 8, 1],
    ["19 (above the range)", 19, 8, 1],
    ["255", 255, 8, 1],
    ["0", 0, 8, 1],
    ["r 9", 17, 9, 1],
    ["p 2", 17, 8, 2],
  ])("refuses the cost %s before any key is derived", async (_name, log2n, r, p) => {
    const file = join(dir, "forged.enc");
    const header = Buffer.concat([MAGIC, Buffer.from([log2n, r, p]), randomBytes(16), randomBytes(12)]);
    writeFileSync(file, Buffer.concat([header, randomBytes(100), randomBytes(16)]));
    await expect(decryptFile(file, join(dir, "plain.tar.gz"), PASSPHRASE)).rejects.toThrow(BAD);
    expect(scryptSpy).not.toHaveBeenCalled();
    expect(names()).toEqual(["forged.enc"]);
  });

  it.each([14, 18])(
    "accepts the edge cost 2^%i",
    async (log2n) => {
      const file = await craft(plain.subarray(0, 4096), { log2n });
      const out = join(dir, "plain.tar.gz");
      await decryptFile(file, out, PASSPHRASE);
      expect(readFileSync(out).equals(plain.subarray(0, 4096))).toBe(true);
    },
    30_000,
  );

  it("refuses a passphrase under the minimum on encrypt, counting characters, and derives nothing", async () => {
    expect(MIN_PASSPHRASE).toBe(12);
    const out = join(dir, "short.enc");
    for (const short of ["x".repeat(11), "\u{1F600}".repeat(4), ""]) {
      await expect(encryptStream(chunks(plain), out, short)).rejects.toThrow(
        "the passphrase needs at least 12 characters",
      );
    }
    expect(scryptSpy).not.toHaveBeenCalled();
    expect(names()).toEqual([]);
    await encryptStream(chunks(plain), out, "x".repeat(12));
    expect(names()).toEqual(["short.enc"]);
  });

  it("never writes over an existing path, and leaves it alone", async () => {
    const existing = join(dir, "existing.enc");
    writeFileSync(existing, "precious");
    await expect(encryptStream(chunks(plain), existing, PASSPHRASE)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(readFileSync(existing, "utf8")).toBe("precious");
    const sealedFile = await sealed();
    await expect(decryptFile(sealedFile, existing, PASSPHRASE)).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(existing, "utf8")).toBe("precious");
  });

  it("derives the same key from a composed and a decomposed passphrase (NFKC)", async () => {
    const composed = "caf\u00e9 au lait 123";
    const decomposed = "cafe\u0301 au lait 123";
    expect(composed).not.toBe(decomposed);
    const file = join(dir, "nfkc.enc");
    await encryptStream(chunks(plain), file, composed);
    const out = join(dir, "plain.tar.gz");
    await decryptFile(file, out, decomposed);
    expect(readFileSync(out).equals(plain)).toBe(true);
  });

  it("removes the output and destroys the source when the source fails", async () => {
    const out = join(dir, "broken.enc");
    const source = new Readable({
      read() {
        this.push(randomBytes(1000));
        this.destroy(new Error("source broke"));
      },
    });
    await expect(encryptStream(source, out, PASSPHRASE)).rejects.toThrow("source broke");
    expect(names()).toEqual([]);
  });

  it("destroys the source and creates nothing when key derivation fails", async () => {
    scryptSpy.mockImplementation(((...args: unknown[]) => {
      (args[4] as (error: Error) => void)(new Error(`secret ${PASSPHRASE}`));
    }) as never);
    const source = chunks(plain);
    const out = join(dir, "never.enc");
    const failure = await encryptStream(source, out, PASSPHRASE).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BackupCryptoError);
    expect((failure as Error).message).toBe("key derivation failed");
    expect(source.destroyed).toBe(true);
    expect(names()).toEqual([]);
  });

  it("never puts the passphrase in an error message", async () => {
    const file = await sealed();
    const wrong = await decryptFile(file, join(dir, "o"), "wrong passphrase value").catch(
      (e: Error) => e.message,
    );
    const brief = await encryptStream(chunks(plain), join(dir, "o2"), "tiny pass").catch(
      (e: Error) => e.message,
    );
    expect(wrong).toBe(CHANGED);
    expect(brief).toBe("the passphrase needs at least 12 characters");
  });

  it.skipIf(process.getuid?.() === 0)(
    "reads a file it cannot open as a plain error, not a container error",
    async () => {
      const file = await sealed();
      chmodSync(file, 0o000);
      await expect(decryptFile(file, join(dir, "o"), PASSPHRASE)).rejects.toThrow(/EACCES/);
    },
  );
  it("refuses bytes appended after the tag, writing nothing", async () => {
    const file = await sealed();
    writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from("x")]));
    await expect(decryptFile(file, join(dir, "plain.tar.gz"), PASSPHRASE)).rejects.toThrow(CHANGED);
    expect(names()).toEqual(["backup.enc"]);
  });

  it("refuses a symbolic link and a FIFO as the input, without waiting for a writer", async () => {
    const file = await sealed();
    const link = join(dir, "link.enc");
    symlinkSync(file, link);
    await expect(decryptFile(link, join(dir, "plain.tar.gz"), PASSPHRASE)).rejects.toThrow(
      "the backup path is not a regular file",
    );
    const fifo = join(dir, "fifo.enc");
    execFileSync("mkfifo", [fifo]);
    await expect(decryptFile(fifo, join(dir, "plain.tar.gz"), PASSPHRASE)).rejects.toThrow(
      "the backup path is not a regular file",
    );
    expect(scryptSpy).toHaveBeenCalledTimes(1); // the one from sealed()
    expect(names()).toEqual(["backup.enc", "fifo.enc", "link.enc"]);
  });

  it("zeroes the passphrase bytes and the derived key after use, on encrypt and on decrypt", async () => {
    const seen: { secret: Buffer; key: Uint8Array }[] = [];
    scryptSpy.mockImplementation(((secret: Buffer, ...rest: unknown[]) => {
      const callback = rest.at(-1) as (error: Error | null, key: Buffer) => void;
      const copy: { secret: Buffer; key: Uint8Array } = { secret, key: new Uint8Array(0) };
      seen.push(copy);
      (actualScrypt as (...args: unknown[]) => void)(
        secret,
        ...rest.slice(0, -1),
        (error: Error | null, key: Buffer) => {
          copy.key = key;
          callback(error, key);
        },
      );
    }) as never);
    const file = await sealed();
    await decryptFile(file, join(dir, "plain.tar.gz"), PASSPHRASE);
    expect(seen).toHaveLength(2);
    for (const { secret, key } of seen) {
      expect(key.length).toBe(32);
      expect(secret.every((byte) => byte === 0)).toBe(true);
      expect(key.every((byte) => byte === 0)).toBe(true);
    }
  });
});
