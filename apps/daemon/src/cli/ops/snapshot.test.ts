import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restoreDatabaseFile, schemaIds, SnapshotError, snapshotDatabase } from "./snapshot.ts";

const renames = vi.hoisted(() => ({ seen: [] as { to: string; walExists: boolean; shmExists: boolean }[] }));
const copyHook = vi.hoisted(() => ({ failWith: null as string | null }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    copyFileSync: (from: string, to: string, flags?: number) => {
      if (copyHook.failWith !== null) {
        actual.writeFileSync(to, "partial"); // what a full disk leaves behind
        throw Object.assign(new Error("injected"), { code: copyHook.failWith });
      }
      return actual.copyFileSync(from, to, flags);
    },
    renameSync: (from: string, to: string) => {
      renames.seen.push({
        to: String(to),
        walExists: actual.existsSync(`${String(to)}-wal`),
        shmExists: actual.existsSync(`${String(to)}-shm`),
      });
      return actual.renameSync(from, to);
    },
  };
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-snapshot-"));
  renames.seen.length = 0;
  copyHook.failWith = null;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeDb(path: string, ids: string[], rows: string[] = [], wal = false): DatabaseSync {
  const db = new DatabaseSync(path);
  if (wal) db.exec("PRAGMA journal_mode = WAL");
  db.exec(
    "CREATE TABLE schema_migrations (id TEXT PRIMARY KEY) STRICT; CREATE TABLE note (body TEXT) STRICT",
  );
  for (const id of ids) db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(id);
  for (const row of rows) db.prepare("INSERT INTO note (body) VALUES (?)").run(row);
  return db;
}
const bodies = (path: string): string[] => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("SELECT body FROM note ORDER BY rowid").all() as { body: string }[]).map(
      (r) => r.body,
    );
  } finally {
    db.close();
  }
};
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const mode = (path: string) => statSync(path).mode & 0o777;

describe("snapshotDatabase", () => {
  it("a WAL database with an open writer and an uncheckpointed row: the snapshot has the row, mode 0600, integrity ok", () => {
    const source = join(dir, "state.db");
    const writer = makeDb(source, ["kernel/a.sql"], ["one"], true);
    writer.exec("PRAGMA wal_autocheckpoint = 0");
    writer.prepare("INSERT INTO note (body) VALUES (?)").run("in-the-wal");
    expect(existsSync(`${source}-wal`)).toBe(true);
    const out = join(dir, "snaps", "s.db");
    snapshotDatabase(source, out);
    writer.close();
    expect(bodies(out)).toEqual(["one", "in-the-wal"]);
    expect(mode(out)).toBe(0o600);
    expect(mode(join(dir, "snaps"))).toBe(0o700);
    expect(schemaIds(out)).toEqual(["kernel/a.sql"]);
    expect(readdirSync(join(dir, "snaps"))).toEqual(["s.db"]);
  });

  it("a stopped, cleanly closed WAL database: the folder listing is unchanged plus the snapshot (0600), no -wal or -shm appears", () => {
    const home = join(dir, "home");
    mkdirSync(home);
    const source = join(home, "state.db");
    makeDb(source, ["a"], ["one"], true).close();
    expect(readdirSync(home)).toEqual(["state.db"]);
    const out = join(home, "backups", "s.db");
    snapshotDatabase(source, out);
    expect(readdirSync(home).sort()).toEqual(["backups", "state.db"]);
    expect(bodies(out)).toEqual(["one"]);
    expect(mode(out)).toBe(0o600);
  });

  it("an existing parent folder with umask 022: the snapshot is still 0600", () => {
    const source = join(dir, "state.db");
    makeDb(source, ["a"]).close();
    mkdirSync(join(dir, "open"), { mode: 0o755 });
    const previous = process.umask(0o022);
    try {
      snapshotDatabase(source, join(dir, "open", "s.db"));
    } finally {
      process.umask(previous);
    }
    expect(mode(join(dir, "open", "s.db"))).toBe(0o600);
  });

  it("a -wal and -shm that existed before are kept", () => {
    const source = join(dir, "state.db");
    const writer = makeDb(source, ["a"], ["one"], true);
    snapshotDatabase(source, join(dir, "s.db"));
    expect(existsSync(`${source}-wal`)).toBe(true);
    expect(existsSync(`${source}-shm`)).toBe(true);
    writer.close();
  });

  it("a leftover -wal with no -shm: the snapshot has the logged row, the -wal stays and no -shm is left behind", () => {
    const live = join(dir, "live");
    const home = join(dir, "crashed");
    mkdirSync(live);
    mkdirSync(home);
    const writer = makeDb(join(live, "state.db"), ["a"], ["one"], true);
    writer.exec("PRAGMA wal_autocheckpoint = 0");
    writer.prepare("INSERT INTO note (body) VALUES (?)").run("in-the-wal");
    copyFileSync(join(live, "state.db"), join(home, "state.db"));
    copyFileSync(join(live, "state.db-wal"), join(home, "state.db-wal"));
    writer.close();
    snapshotDatabase(join(home, "state.db"), join(dir, "s.db"), { held: true });
    expect(bodies(join(dir, "s.db"))).toEqual(["one", "in-the-wal"]);
    expect(readdirSync(home).sort()).toEqual(["state.db", "state.db-wal"]);
  });

  it("a caller without the instance lock never removes a sidecar, not even one this call made", () => {
    const live = join(dir, "live");
    const home = join(dir, "crashed2");
    mkdirSync(live);
    mkdirSync(home);
    const writer = makeDb(join(live, "state.db"), ["a"], ["one"], true);
    writer.exec("PRAGMA wal_autocheckpoint = 0");
    writer.prepare("INSERT INTO note (body) VALUES (?)").run("in-the-wal");
    copyFileSync(join(live, "state.db"), join(home, "state.db"));
    copyFileSync(join(live, "state.db-wal"), join(home, "state.db-wal"));
    writer.close();
    snapshotDatabase(join(home, "state.db"), join(dir, "s2.db"));
    expect(bodies(join(dir, "s2.db"))).toEqual(["one", "in-the-wal"]);
    expect(readdirSync(home).sort()).toEqual(["state.db", "state.db-shm", "state.db-wal"]);
  });

  it("a daemon that starts during the snapshot keeps its -wal and -shm, and the snapshot is redone with its rows", () => {
    const home = join(dir, "starting");
    mkdirSync(home);
    const source = join(home, "state.db");
    makeDb(source, ["a"], ["one"], true).close();
    let daemon: DatabaseSync | undefined;
    let calls = 0;
    snapshotDatabase(source, join(dir, "s3.db"), {
      whileOpen: () => {
        if (calls++ > 0) return;
        daemon = new DatabaseSync(source);
        daemon.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
        daemon.prepare("INSERT INTO note (body) VALUES (?)").run("from-the-daemon");
      },
    });
    expect(existsSync(`${source}-wal`)).toBe(true);
    expect(existsSync(`${source}-shm`)).toBe(true);
    expect(bodies(join(dir, "s3.db"))).toEqual(["one", "from-the-daemon"]);
    daemon?.close();
  });

  it("an existing outPath is refused and left untouched", () => {
    const source = join(dir, "state.db");
    makeDb(source, ["a"]).close();
    const out = join(dir, "s.db");
    writeFileSync(out, "precious");
    expect(() => snapshotDatabase(source, out)).toThrow(SnapshotError);
    expect(readFileSync(out, "utf8")).toBe("precious");
  });

  it("a missing source throws SnapshotError and leaves no .tmp", () => {
    const out = join(dir, "s.db");
    expect(() => snapshotDatabase(join(dir, "missing.db"), out)).toThrow(SnapshotError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("source is never written: bytes and mtime of the source are unchanged", () => {
    const source = join(dir, "state.db");
    makeDb(source, ["a"], ["x"]).close();
    const before = { hash: sha(source), mtime: statSync(source).mtimeMs, mode: mode(source) };
    snapshotDatabase(source, join(dir, "s.db"));
    expect({ hash: sha(source), mtime: statSync(source).mtimeMs, mode: mode(source) }).toEqual(before);
  });
});

describe("schemaIds", () => {
  it("returns the sorted ids", () => {
    const path = join(dir, "x.db");
    makeDb(path, ["kernel/b.sql", "auth/a.sql", "kernel/a.sql"]).close();
    expect(schemaIds(path)).toEqual(["auth/a.sql", "kernel/a.sql", "kernel/b.sql"]);
  });
  it("returns null for a file that is not a database", () => {
    const path = join(dir, "x.db");
    writeFileSync(path, "this is not sqlite at all, just text".repeat(20));
    expect(schemaIds(path)).toBeNull();
  });
  it("returns null for a missing file", () => {
    expect(schemaIds(join(dir, "nope.db"))).toBeNull();
  });
  it("returns null when integrity_check fails (a page flipped in a copy)", () => {
    const path = join(dir, "x.db");
    const db = makeDb(path, ["a"]);
    db.exec("CREATE INDEX note_body ON note (body)");
    for (let i = 0; i < 400; i++)
      db.prepare("INSERT INTO note (body) VALUES (?)").run(`row-${i}-${"y".repeat(60)}`);
    db.close();
    const bytes = readFileSync(path);
    const flipped = join(dir, "flipped.db");
    const copy = Buffer.from(bytes);
    for (let i = 3 * 4096; i < copy.length; i++) copy[i] = 0xff; // every page after the first three
    writeFileSync(flipped, copy);
    expect(schemaIds(flipped)).toBeNull();
    expect(schemaIds(path)).toEqual(["a"]);
  });
});

describe("restoreDatabaseFile", () => {
  const home = () => join(dir, "home");
  function setup() {
    mkdirSync(home(), { recursive: true });
    const snap = join(dir, "snap.db");
    makeDb(snap, ["kernel/a.sql"], ["from-snapshot"]).close();
    const target = join(home(), "state.db");
    return { snap, target };
  }

  it("an id not in knownIds throws and state.db is unchanged", () => {
    const { snap, target } = setup();
    makeDb(target, ["kernel/a.sql"], ["old"]).close();
    const before = sha(target);
    expect(() => restoreDatabaseFile(snap, home(), new Set(["kernel/other.sql"]))).toThrow(/newer pap/);
    expect(sha(target)).toBe(before);
    expect(readdirSync(home())).toEqual(["state.db"]);
  });

  it("a damaged snapshot throws and state.db is unchanged", () => {
    const { target } = setup();
    makeDb(target, ["kernel/a.sql"], ["old"]).close();
    const before = sha(target);
    const bad = join(dir, "bad.db");
    writeFileSync(bad, "garbage".repeat(50));
    expect(() => restoreDatabaseFile(bad, home(), new Set(["kernel/a.sql"]))).toThrow(/damaged/);
    expect(sha(target)).toBe(before);
  });

  it("removes a planted -wal and -shm BEFORE the rename, restores the snapshot rows, mode 0600, no .restore-* left", () => {
    const { snap, target } = setup();
    const writer = makeDb(target, ["kernel/a.sql"], ["old"], true);
    writer.exec("PRAGMA wal_autocheckpoint = 0");
    writer.prepare("INSERT INTO note (body) VALUES (?)").run("old-in-wal");
    copyFileSync(`${target}-wal`, join(dir, "wal.copy"));
    copyFileSync(`${target}-shm`, join(dir, "shm.copy"));
    const stateCopy = join(dir, "state.copy");
    copyFileSync(target, stateCopy);
    writer.close();
    // the home as a crashed daemon left it: the database, with a live log beside it
    rmSync(target, { force: true });
    copyFileSync(stateCopy, target);
    copyFileSync(join(dir, "wal.copy"), `${target}-wal`);
    copyFileSync(join(dir, "shm.copy"), `${target}-shm`);
    renames.seen.length = 0;

    restoreDatabaseFile(snap, home(), new Set(["kernel/a.sql"]));

    expect(renames.seen).toEqual([{ to: target, walExists: false, shmExists: false }]);
    expect(bodies(target)).toEqual(["from-snapshot"]);
    expect(readdirSync(home()).sort()).toEqual(["state.db"]);
    expect(mode(target)).toBe(0o600);
  });

  it("works when there is no state.db yet", () => {
    const { snap, target } = setup();
    restoreDatabaseFile(snap, home(), new Set(["kernel/a.sql"]));
    expect(bodies(target)).toEqual(["from-snapshot"]);
  });

  it("a home that does not exist throws SnapshotError and leaves no .restore-* file", () => {
    const { snap, target } = setup();
    makeDb(target, ["kernel/a.sql"], ["old"]).close();
    const before = sha(target);
    expect(() => restoreDatabaseFile(snap, join(dir, "no-such-home"), new Set(["kernel/a.sql"]))).toThrow(
      SnapshotError,
    );
    expect(sha(target)).toBe(before);
    expect(existsSync(join(dir, "no-such-home"))).toBe(false);
  });

  it("an ENOSPC copy failure throws SnapshotError, leaves no .restore-* file and state.db unchanged", () => {
    const { snap, target } = setup();
    makeDb(target, ["kernel/a.sql"], ["old"]).close();
    const before = sha(target);
    copyHook.failWith = "ENOSPC";
    expect(() => restoreDatabaseFile(snap, home(), new Set(["kernel/a.sql"]))).toThrow(
      /restore failed: ENOSPC/,
    );
    expect(readdirSync(home())).toEqual(["state.db"]);
    expect(sha(target)).toBe(before);
  });
});
