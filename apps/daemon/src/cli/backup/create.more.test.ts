import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  linkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBackup, type BackupDeps } from "./create.ts";

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

describe("createBackup: links, part names and --keep", () => {
  it("stores two hard-linked files as regular members with full content", async () => {
    linkSync(join(home, "agents", "one", "memory.md"), join(home, "agents", "one", "second.md"));
    const result = await createBackup(deps());
    const verbose = execFileSync("tar", ["-tvzf", result.path], { encoding: "utf8" });
    expect(verbose.split("\n").filter((line) => line.startsWith("h"))).toEqual([]);
    const extract = join(scratch, "extract");
    mkdirSync(extract);
    execFileSync("tar", ["-xzf", result.path, "-C", extract]);
    expect(readFileSync(join(extract, "agents/one/memory.md"), "utf8")).toBe("mem");
    expect(readFileSync(join(extract, "agents/one/second.md"), "utf8")).toBe("mem");
  });

  it("uses a different .part name for each run, so parallel runs never share one", async () => {
    const seen: string[] = [];
    const selfCheck = (file: string): Promise<void> => {
      seen.push(file);
      return Promise.resolve();
    };
    await createBackup(deps({ selfCheck }));
    await createBackup(deps({ selfCheck, now: new Date(NOW.getTime() + 1000) }));
    expect(new Set(seen.map((file) => file.split(".").at(-2))).size).toBe(2);
  });

  describe("--keep", () => {
    it("removes the oldest older pap-backup files and never the new file or another name", async () => {
      mkdirSync(outDir);
      const stamps = ["20260101T000000Z", "20260102T000000Z", "20260103T000000Z", "20260104T000000Z"];
      stamps.forEach((stamp, index) => {
        const file = join(outDir, `pap-backup-${stamp}.tar.gz`);
        writeFileSync(file, "old");
        utimesSync(file, 1_000 + index, 1_000 + index);
      });
      writeFileSync(join(outDir, "notes.txt"), "mine");
      writeFileSync(join(outDir, "pap-backup-notes.tar.gz"), "mine too");
      const result = await createBackup(deps({ keep: 2 }));
      expect(result.pruned).toBe(2);
      expect(readdirSync(outDir).sort()).toEqual(
        [
          "notes.txt",
          NAME,
          "pap-backup-20260103T000000Z.tar.gz",
          "pap-backup-20260104T000000Z.tar.gz",
          "pap-backup-notes.tar.gz",
        ].sort(),
      );
    });

    it("prunes nothing without --keep", async () => {
      mkdirSync(outDir);
      writeFileSync(join(outDir, "pap-backup-20260101T000000Z.tar.gz"), "old");
      expect((await createBackup(deps())).pruned).toBe(0);
      expect(readdirSync(outDir)).toHaveLength(2);
    });
  });
});
