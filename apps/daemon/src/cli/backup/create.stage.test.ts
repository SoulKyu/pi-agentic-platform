import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackupCryptoError } from "./crypto.ts";
import { BackupError, createBackup, type BackupDeps } from "./create.ts";

const NOW = new Date(Date.UTC(2026, 9, 17, 10, 0, 0));
const NAME = "pap-backup-20261017T100000Z.tar.gz.enc";

let scratch: string;
let home: string;
let piDir: string;
let outDir: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-backup-stage-"));
  home = join(scratch, "home");
  piDir = join(scratch, "pi");
  outDir = join(scratch, "out");
  mkdirSync(join(home, "secrets", "vault"), { recursive: true });
  mkdirSync(join(home, "attachments"), { recursive: true });
  mkdirSync(piDir, { recursive: true });
  writeFileSync(join(home, "secrets", "vault", "key"), "TOPSECRET");
  writeFileSync(join(home, "attachments", "big.bin"), randomBytes(4 * 1024 * 1024));
  const db = new DatabaseSync(join(home, "state.db"));
  db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY)");
  db.exec("INSERT INTO schema_migrations VALUES ('kernel/202610100000_init.sql')");
  db.close();
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const deps = (extra: Partial<BackupDeps> = {}): BackupDeps => ({
  home,
  piDir,
  outDir,
  now: NOW,
  papVersion: "0.0.0",
  secrets: "include",
  skip: new Set(["pi"]),
  allowLarge: false,
  ...extra,
});

const drain = async (stream: Readable): Promise<void> => {
  for await (const chunk of stream) void chunk;
};

describe("the stage folder of an encrypted backup", () => {
  it("is in the home, never in the output folder: the plain snapshot and the lists stay off removable media", async () => {
    const seen: { outDir: string[]; stages: string[] }[] = [];
    const look = () => ({
      outDir: existsSync(outDir) ? readdirSync(outDir) : [],
      stages: readdirSync(join(home, "tmp")),
    });
    const encrypt = async (stream: Readable, part: string): Promise<void> => {
      seen.push(look());
      await drain(stream);
      seen.push(look());
      writeFileSync(part, "ciphertext");
    };
    const result = await createBackup(deps({ encrypt }));
    expect(seen).toHaveLength(2);
    for (const view of seen) {
      expect(view.outDir).toEqual([]);
      expect(view.stages).toHaveLength(1);
      expect(view.stages[0]).toMatch(/^\.backup-stage-/);
    }
    expect(readdirSync(outDir)).toEqual([NAME]);
    expect(readdirSync(join(home, "tmp"))).toEqual([]);
    expect(result.path).toBe(join(outDir, NAME));
  });

  it("is removed from the home when the backup fails", async () => {
    const encrypt = async (stream: Readable): Promise<void> => {
      await drain(stream);
      throw new Error("boom");
    };
    await expect(createBackup(deps({ encrypt }))).rejects.toThrow(BackupError);
    expect(readdirSync(join(home, "tmp"))).toEqual([]);
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("checks the snapshot's space at the home and the archive's at the output folder", async () => {
    const asked: string[] = [];
    await createBackup(
      deps({
        encrypt: async (stream, part) => {
          await drain(stream);
          writeFileSync(part, "x");
        },
        freeMb: (path) => {
          asked.push(path);
          return 100_000;
        },
      }),
    );
    expect(asked).toEqual([outDir, home]);
  });

  it("refuses when the home has no room for the snapshot, before anything is written", async () => {
    const error = (await createBackup(
      deps({ secrets: "exclude", freeMb: (path) => (path === home ? 1 : 100_000) }),
    ).catch((e: unknown) => e as Error)) as Error;
    expect(error).toBeInstanceOf(BackupError);
    expect(error.message).toMatch(new RegExp(`free space in ${home}: 1 MB free`));
    expect(existsSync(outDir)).toBe(false);
    expect(existsSync(join(home, "tmp"))).toBe(false);
  });
});

describe("a failing sink", () => {
  const failing = (error: Error) => async (stream: Readable) => {
    for await (const chunk of stream) {
      void chunk;
      throw error;
    }
  };

  it("names the real cause, not the exit code tar gets from the closed pipe", async () => {
    const error = (await createBackup(
      deps({ encrypt: failing(Object.assign(new Error("disk"), { code: "ENOSPC" })) }),
    ).catch((e: unknown) => e as Error)) as Error;
    expect(error).toBeInstanceOf(BackupError);
    expect(error.message).toBe("the archive could not be written: ENOSPC");
    expect(readdirSync(outDir)).toEqual([]);
    expect(readdirSync(join(home, "tmp"))).toEqual([]);
  });

  it("shows the fixed text of an encryption error", async () => {
    const error = (await createBackup(
      deps({ encrypt: failing(new BackupCryptoError("key derivation failed")) }),
    ).catch((e: unknown) => e as Error)) as Error;
    expect(error.message).toBe("key derivation failed");
  });
});
