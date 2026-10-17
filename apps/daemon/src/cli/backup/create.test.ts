import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schemaIds } from "../ops/snapshot.ts";
import { createBackup, BackupError, type BackupDeps } from "./create.ts";
import { ManifestSchema } from "./manifest.ts";

const NOW = new Date(Date.UTC(2026, 9, 17, 10, 0, 0));
const NAME = "pap-backup-20261017T100000Z.tar.gz";
const IDS = ["kernel/202610100000_init.sql", "auth/202610110000_users.sql"];

let scratch: string;
let home: string;
let piDir: string;
let outDir: string;

const put = (root: string, relative: string, text = "x"): void => {
  mkdirSync(join(root, relative, ".."), { recursive: true });
  writeFileSync(join(root, relative), text);
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-backup-create-"));
  home = join(scratch, "home");
  piDir = join(scratch, "pi");
  outDir = join(scratch, "out");
  mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(join(home, "state.db"));
  db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY); CREATE TABLE t (v TEXT)");
  for (const id of IDS) db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(id);
  db.exec("INSERT INTO t VALUES ('hello')");
  db.close();
  put(home, "attachments/a.bin", "att");
  put(home, "agents/one/memory.md", "mem");
  put(home, "exports/e.json", "{}");
  put(home, "secrets/vault/key", "TOPSECRET");
  put(home, "secrets/push/vapid.json", "VAPID");
  put(home, "search.db", "cache");
  put(home, "worktrees/w/file", "w");
  put(home, "logs/trace.jsonl", "l");
  put(piDir, "sessions/s1/a.jsonl", "session");
  put(piDir, "auth.json", "AUTH");
  put(piDir, "models.json", "{}");
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const deps = (extra: Partial<BackupDeps> = {}): BackupDeps => ({
  home,
  piDir,
  outDir,
  now: NOW,
  papVersion: "0.0.0",
  secrets: "exclude",
  skip: new Set(),
  allowLarge: false,
  ...extra,
});

const members = (file: string): string[] =>
  execFileSync("tar", ["-tzf", file], { encoding: "utf8" }).split("\n").filter(Boolean);

const fakeTar = (script: string): string => {
  const bin = join(scratch, "fakebin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "tar"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return bin;
};

const withPath = async <T>(bin: string, step: () => Promise<T>): Promise<T> => {
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  try {
    return await step();
  } finally {
    process.env.PATH = before;
  }
};

describe("createBackup", () => {
  it("lists manifest, state.db, the home tops, then the Pi sessions, and nothing else", async () => {
    const result = await createBackup(deps());
    expect(result.path).toBe(join(outDir, NAME));
    expect(members(result.path)).toEqual([
      "manifest.json",
      "state.db",
      "attachments/",
      "attachments/a.bin",
      "agents/",
      "agents/one/",
      "agents/one/memory.md",
      "exports/",
      "exports/e.json",
      "pi-agent/sessions/",
      "pi-agent/sessions/s1/",
      "pi-agent/sessions/s1/a.jsonl",
    ]);
    expect(result.tops).toEqual(["attachments", "agents", "exports", "pi-agent"]);
    expect(result.secretsIncluded).toBe(false);
    expect(result.bytes).toBe(statSync(result.path).size);
  });

  it("never carries secrets/, auth.json, models.json, search.db, worktrees or logs", async () => {
    const result = await createBackup(deps());
    const text = members(result.path).join("\n");
    for (const banned of [
      "secrets",
      "vault",
      "vapid",
      "auth.json",
      "models.json",
      "search.db",
      "worktrees",
      "logs",
    ])
      expect(text).not.toContain(banned);
    expect(readFileSync(result.path).includes("TOPSECRET")).toBe(false);
  });

  it("writes a manifest whose hash and schema match the extracted state.db", async () => {
    const result = await createBackup(deps());
    const extract = join(scratch, "extract");
    mkdirSync(extract);
    execFileSync("tar", ["-xzf", result.path, "-C", extract]);
    const manifest = ManifestSchema.parse(JSON.parse(readFileSync(join(extract, "manifest.json"), "utf8")));
    const bytes = readFileSync(join(extract, "state.db"));
    expect(manifest.stateDb).toEqual({
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
    expect(manifest.schema).toEqual(schemaIds(join(extract, "state.db")));
    expect(manifest.schema).toEqual([...IDS].sort());
    expect(manifest.createdAt).toBe("2026-10-17T10:00:00.000Z");
    expect(manifest.secrets).toBe("excluded");
    expect(manifest.tops).toEqual(["attachments", "agents", "exports", "pi-agent"]);
  });

  it("makes the archive 0600 and a folder it creates 0700", async () => {
    const result = await createBackup(deps());
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    expect(statSync(outDir).mode & 0o777).toBe(0o700);
  });

  it("refuses a name that exists and leaves the first archive alone", async () => {
    const first = await createBackup(deps());
    const before = readFileSync(first.path);
    await expect(createBackup(deps())).rejects.toThrow(`${NAME} exists`);
    expect(readFileSync(first.path).equals(before)).toBe(true);
    expect(readdirSync(outDir)).toEqual([NAME]);
  });

  it("counts a symbolic link as skipped, in the result and the manifest", async () => {
    symlinkSync("/etc/passwd", join(home, "agents", "link"));
    const result = await createBackup(deps());
    expect(result.skipped).toEqual({ links: 1, names: 0, changed: 0 });
    expect(result.examples).toEqual(["agents/link"]);
    expect(members(result.path)).not.toContain("agents/link");
    const extract = join(scratch, "extract");
    mkdirSync(extract);
    execFileSync("tar", ["-xzf", result.path, "-C", extract, "manifest.json"]);
    expect(JSON.parse(readFileSync(join(extract, "manifest.json"), "utf8")).skipped).toEqual({
      links: 1,
      names: 0,
      changed: 0,
    });
  });

  it("leaves out what --skip names", async () => {
    const result = await createBackup(deps({ skip: new Set(["pi", "agents"]) }));
    expect(result.tops).toEqual(["attachments", "exports"]);
    expect(members(result.path)).toEqual([
      "manifest.json",
      "state.db",
      "attachments/",
      "attachments/a.bin",
      "exports/",
      "exports/e.json",
    ]);
  });

  it("works with no Pi sessions folder at all", async () => {
    rmSync(piDir, { recursive: true });
    const result = await createBackup(deps());
    expect(result.tops).toEqual(["attachments", "agents", "exports"]);
  });

  it("refuses a missing or damaged state.db and writes nothing", async () => {
    writeFileSync(join(home, "state.db"), "not a database at all");
    await expect(createBackup(deps())).rejects.toThrow(BackupError);
    expect(readdirSync(outDir)).toEqual([]);
    rmSync(join(home, "state.db"));
    await expect(createBackup(deps())).rejects.toThrow("no pap data");
  });

  describe("gates", () => {
    it("refuses a payload above 2 GiB with the size of each top, and creates nothing", async () => {
      mkdirSync(outDir);
      truncateSync(join(home, "attachments", "a.bin"), 3 * 1024 ** 3);
      const error = (await createBackup(deps()).catch((e: unknown) => e as Error)) as Error;
      expect(error).toBeInstanceOf(BackupError);
      expect(error.message).toContain("--allow-large");
      expect(error.message).toContain("attachments 3072.0 MiB");
      expect(error.message).toContain("agents 0.0 MiB");
      expect(readdirSync(outDir)).toEqual([]);
    });

    it("--allow-large passes the payload gate (the disk gate answers instead)", async () => {
      truncateSync(join(home, "attachments", "a.bin"), 3 * 1024 ** 3);
      await expect(createBackup(deps({ allowLarge: true, freeMb: () => 0 }))).rejects.toThrow("free space");
    });

    it("refuses a file above 8 GiB even with --allow-large, naming it", async () => {
      truncateSync(join(home, "attachments", "a.bin"), 9 * 1024 ** 3);
      await expect(createBackup(deps({ allowLarge: true }))).rejects.toThrow("attachments/a.bin");
    });

    it("refuses when free space is below the estimate, before anything is written", async () => {
      mkdirSync(outDir);
      const asked: string[] = [];
      const error = (await createBackup(
        deps({
          freeMb: (path) => {
            asked.push(path);
            return 10;
          },
        }),
      ).catch((e: unknown) => e as Error)) as Error;
      expect(error.message).toMatch(/free space .* 10 MB .* 64 MB/);
      expect(asked).toEqual([outDir]);
      expect(readdirSync(outDir)).toEqual([]);
    });

    it("passes when the free space is unknown", async () => {
      const result = await createBackup(deps({ freeMb: () => null }));
      expect(existsSync(result.path)).toBe(true);
    });
  });

  describe("tar", () => {
    it("removes the .part and the stage folder on a tar failure and never shows its stderr", async () => {
      const bin = fakeTar("echo SECRET-STDERR >&2; exit 2");
      const error = (await withPath(bin, () => createBackup(deps())).catch(
        (e: unknown) => e as Error,
      )) as Error;
      expect(error).toBeInstanceOf(BackupError);
      expect(error.message).toContain("tar failed (exit 2)");
      expect(error.message).not.toContain("SECRET-STDERR");
      expect(readdirSync(outDir)).toEqual([]);
      expect(existsSync(join(home, "update", "last-backup.json"))).toBe(false);
    });

    it("accepts exit 1 (a file changed as tar read it) and says so", async () => {
      const bin = fakeTar("echo archive; exit 1");
      const result = await withPath(bin, () => createBackup(deps()));
      expect(result.tarChanged).toBe(true);
      expect(existsSync(result.path)).toBe(true);
      expect(readdirSync(outDir)).toEqual([NAME]);
    });

    it("reports tarChanged false on a clean run", async () => {
      expect((await createBackup(deps())).tarChanged).toBe(false);
    });
  });

  describe("last-backup.json", () => {
    it("is written 0600 on success", async () => {
      const result = await createBackup(deps());
      const file = join(home, "update", "last-backup.json");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
        createdAt: "2026-10-17T10:00:00.000Z",
        file: NAME,
        encrypted: false,
        secrets: "excluded",
      });
      expect(result.path).toBe(join(outDir, NAME));
    });
  });

  describe("selfCheck", () => {
    it("runs on the finished .part before the rename", async () => {
      const seen: string[] = [];
      const result = await createBackup(
        deps({
          selfCheck: (file) => {
            seen.push(file);
            expect(existsSync(file)).toBe(true);
            expect(existsSync(join(outDir, NAME))).toBe(false);
            return Promise.resolve();
          },
        }),
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatch(new RegExp(`^${join(outDir, NAME)}\\.\\d+\\.[0-9a-f]{8}\\.part$`));
      expect(existsSync(result.path)).toBe(true);
    });

    it("removes the .part and says the archive failed its own check", async () => {
      const error = (await createBackup(
        deps({ selfCheck: () => Promise.reject(new Error("symlink inside")) }),
      ).catch((e: unknown) => e as Error)) as Error;
      expect(error.message).toBe("the archive failed its own check and was removed");
      expect(readdirSync(outDir)).toEqual([]);
      expect(existsSync(join(home, "update", "last-backup.json"))).toBe(false);
    });
  });

  describe("encryption hook and secrets", () => {
    const copy = (plain: NodeJS.ReadableStream, outPath: string): Promise<void> =>
      pipeline(plain, createWriteStream(outPath, { flags: "wx", mode: 0o600 }));

    it("passes the stream to the hook, names the file .enc and skips the self-check", async () => {
      let checked = false;
      const result = await createBackup(
        deps({
          encrypt: copy,
          selfCheck: () => {
            checked = true;
            return Promise.resolve();
          },
        }),
      );
      expect(result.path).toBe(join(outDir, `${NAME}.enc`));
      expect(result.encrypted).toBe(true);
      expect(checked).toBe(false);
      expect(members(result.path)).toContain("state.db");
    });

    it("puts secrets/ in only for include + encrypt", async () => {
      const result = await createBackup(deps({ encrypt: copy, secrets: "include" }));
      expect(result.secretsIncluded).toBe(true);
      expect(members(result.path)).toContain("secrets/vault/key");
      expect(members(result.path)).toContain("secrets/push/vapid.json");
      expect(result.tops).toEqual(["attachments", "agents", "exports", "secrets", "pi-agent"]);
    });

    it("refuses include without encrypt", async () => {
      await expect(createBackup(deps({ secrets: "include" }))).rejects.toThrow(
        "secrets can only be included in an encrypted backup",
      );
      expect(existsSync(outDir)).toBe(false);
    });
  });
});
