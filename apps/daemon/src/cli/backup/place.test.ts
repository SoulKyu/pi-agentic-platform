import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOME_TOPS, PlaceError, placeRestored } from "./place.ts";

const STAMP = "20261017T100000Z";
const isRoot = process.getuid?.() === 0;

let home: string;
let extracted: string;

const database = (path: string, marker: string): void => {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY); CREATE TABLE t (v TEXT)");
  db.prepare("INSERT INTO t VALUES (?)").run(marker);
  db.close();
};
const marker = (path: string): string => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("SELECT v FROM t").get() as { v: string }).v;
  } finally {
    db.close();
  }
};
const put = (path: string, text: string): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const read = (path: string): string => readFileSync(path, "utf8");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pap-place-"));
  extracted = join(home, "tmp", "restore-stage");
  mkdirSync(extracted, { recursive: true });
  database(join(home, "state.db"), "old");
  put(join(home, "attachments/a"), "old-a");
  put(join(home, "agents/one/m"), "old-agent");
  put(join(home, "search.db"), "cache");
  put(join(home, "search.db-wal"), "w");
  put(join(home, "search.db-shm"), "s");
  database(join(extracted, "state.db"), "new");
  put(join(extracted, "attachments/b"), "new-b");
  put(join(extracted, "agents/two/m"), "new-agent");
});
afterEach(() => {
  try {
    chmodSync(join(home, "agents"), 0o700);
  } catch {
    // the folder may have been moved
  }
  rmSync(home, { recursive: true, force: true });
});

describe("placeRestored", () => {
  it("replaces the folders and the database, keeping the old ones under backups/pre-restore-<stamp>", () => {
    put(join(home, "state.db-wal"), "stale");
    put(join(home, "state.db-shm"), "stale");
    const result = placeRestored(home, extracted, STAMP, ["attachments", "agents"]);
    expect(result.keptDatabase).toBe(join(home, "backups", `pre-restore-${STAMP}.db`));
    expect(result.keptFolders).toBe(join(home, "backups", `pre-restore-${STAMP}`));
    expect(marker(join(home, "state.db"))).toBe("new");
    expect(marker(result.keptDatabase ?? "")).toBe("old");
    expect(read(join(home, "attachments/b"))).toBe("new-b");
    expect(existsSync(join(home, "attachments/a"))).toBe(false);
    expect(read(join(home, "agents/two/m"))).toBe("new-agent");
    expect(read(join(home, "backups", `pre-restore-${STAMP}`, "attachments/a"))).toBe("old-a");
    expect(read(join(home, "backups", `pre-restore-${STAMP}`, "agents/one/m"))).toBe("old-agent");
    for (const name of ["search.db", "search.db-wal", "search.db-shm", "state.db-wal", "state.db-shm"]) {
      expect(existsSync(join(home, name)), name).toBe(false);
      expect(existsSync(join(home, "backups", `pre-restore-${STAMP}`, name)), `${name} kept`).toBe(true);
    }
    expect(marker(join(home, "backups", `pre-restore-${STAMP}`, "state.db"))).toBe("old");
    expect(existsSync(join(extracted, "state.db"))).toBe(false);
  });

  it("works when the folders do not exist yet and says nothing was kept", () => {
    rmSync(join(home, "attachments"), { recursive: true });
    rmSync(join(home, "agents"), { recursive: true });
    rmSync(join(home, "state.db"));
    for (const name of ["search.db", "search.db-wal", "search.db-shm"]) rmSync(join(home, name));
    const result = placeRestored(home, extracted, STAMP, ["attachments", "agents"]);
    expect(result).toEqual({ keptDatabase: null, keptFolders: null });
    expect(marker(join(home, "state.db"))).toBe("new");
    expect(read(join(home, "attachments/b"))).toBe("new-b");
    expect(existsSync(join(home, "backups"))).toBe(false);
  });

  it("creates pre-restore-<stamp>/ for the folders after the database snapshot made backups/ (first draft: ENOENT)", () => {
    const result = placeRestored(home, extracted, STAMP, ["attachments"]);
    expect(result.keptFolders).toBe(join(home, "backups", `pre-restore-${STAMP}`));
    expect(read(join(home, "backups", `pre-restore-${STAMP}`, "attachments/a"))).toBe("old-a");
  });

  it("an unexpected top fails with the old folders moved back and the database untouched", () => {
    let error: unknown;
    try {
      placeRestored(home, extracted, STAMP, ["attachments", "worktrees"]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PlaceError);
    expect((error as Error).message).toBe("unexpected folder in the backup");
    expect(read(join(home, "attachments/a"))).toBe("old-a");
    expect(read(join(extracted, "attachments/b"))).toBe("new-b");
    expect(marker(join(home, "state.db"))).toBe("old");
    expect(existsSync(join(home, "search.db"))).toBe(true);
    expect(existsSync(join(home, "backups"))).toBe(false); // refused before anything moved or was snapshotted
  });

  it("refuses a backup with no database before it moves anything", () => {
    rmSync(join(extracted, "state.db"));
    expect(() => placeRestored(home, extracted, STAMP, ["attachments"])).toThrow(
      "the backup holds no database",
    );
    expect(read(join(home, "attachments/a"))).toBe("old-a");
    expect(read(join(extracted, "attachments/b"))).toBe("new-b");
    expect(existsSync(join(home, "backups"))).toBe(false);
  });

  it.skipIf(isRoot)(
    "a rename that fails for the second folder moves the first back and leaves state.db untouched",
    () => {
      chmodSync(join(home, "agents"), 0o500); // a folder cannot be renamed away without write access to itself
      let error: unknown;
      try {
        placeRestored(home, extracted, STAMP, ["attachments", "agents"]);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(PlaceError);
      expect((error as Error).message).toBe(
        "restore failed while placing files (EACCES); the data folder was put back as it was",
      );
      expect(read(join(home, "attachments/a"))).toBe("old-a");
      expect(existsSync(join(home, "attachments/b"))).toBe(false);
      expect(read(join(extracted, "attachments/b"))).toBe("new-b");
      expect(read(join(home, "agents/one/m"))).toBe("old-agent");
      expect(marker(join(home, "state.db"))).toBe("old");
      expect(existsSync(join(home, "search.db"))).toBe(true);
    },
  );

  it("refuses a stamp that was already used, and nothing moves", () => {
    mkdirSync(join(home, "backups", `pre-restore-${STAMP}`, "attachments", "x"), { recursive: true });
    expect(() => placeRestored(home, extracted, STAMP, ["attachments"])).toThrow(PlaceError);
    expect(read(join(home, "attachments/a"))).toBe("old-a");
    expect(marker(join(home, "state.db"))).toBe("old");
  });

  it("lists exactly the folders a restore may place, in order", () => {
    expect(HOME_TOPS).toEqual(["attachments", "agents", "exports", "secrets"]);
  });

  it("refuses a state.db in the stage that is not a regular file, before anything moves", () => {
    rmSync(join(extracted, "state.db"));
    mkdirSync(join(extracted, "state.db"));
    put(join(home, "state.db-wal"), "unflushed");
    expect(() => placeRestored(home, extracted, STAMP, ["attachments"])).toThrow(
      "the backup holds no database",
    );
    expect(read(join(home, "state.db-wal"))).toBe("unflushed");
    expect(read(join(home, "attachments/a"))).toBe("old-a");
  });

  it("validates every top before it moves the first one", () => {
    expect(() => placeRestored(home, extracted, STAMP, ["attachments", "agents", "../etc"])).toThrow(
      "unexpected folder in the backup",
    );
    expect(read(join(home, "attachments/a"))).toBe("old-a");
    expect(read(join(extracted, "agents/two/m"))).toBe("new-agent");
  });

  it("moves the old database and its log aside, never deletes them, and a search.db that is a folder is just kept", () => {
    put(join(home, "state.db-wal"), "unflushed");
    rmSync(join(home, "search.db"));
    put(join(home, "search.db", "inner"), "folder");
    placeRestored(home, extracted, STAMP, ["attachments"]);
    const kept = join(home, "backups", `pre-restore-${STAMP}`);
    expect(read(join(kept, "state.db-wal"))).toBe("unflushed");
    expect(read(join(kept, "search.db", "inner"))).toBe("folder");
    expect(marker(join(home, "state.db"))).toBe("new");
    expect(existsSync(join(home, "search.db"))).toBe(false);
  });

  it("a failure on the last step (the cache) puts the old database back too: the home is never mixed", () => {
    put(join(home, "state.db-wal"), "unflushed");
    const failing = ((from: string, to: string) => {
      if (String(from).endsWith("search.db")) throw Object.assign(new Error("boom"), { code: "EBUSY" });
      return renameSync(from, to);
    }) as typeof renameSync;
    let error: unknown;
    try {
      placeRestored(home, extracted, STAMP, ["attachments", "agents"], failing);
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toBe(
      "restore failed while placing files (EBUSY); the data folder was put back as it was",
    );
    expect(marker(join(home, "state.db"))).toBe("old");
    expect(read(join(home, "state.db-wal"))).toBe("unflushed");
    expect(marker(join(extracted, "state.db"))).toBe("new");
    expect(read(join(home, "attachments/a"))).toBe("old-a");
    expect(read(join(home, "agents/one/m"))).toBe("old-agent");
    expect(read(join(extracted, "attachments/b"))).toBe("new-b");
  });

  it("says where the data is when an undo step fails too", () => {
    let calls = 0;
    const failing = ((from: string, to: string) => {
      calls++;
      if (String(from).endsWith("search.db")) throw Object.assign(new Error("boom"), { code: "EBUSY" });
      if (String(to).endsWith("/attachments") && calls > 3)
        throw Object.assign(new Error("boom"), { code: "EIO" });
      return renameSync(from, to);
    }) as typeof renameSync;
    let error: unknown;
    try {
      placeRestored(home, extracted, STAMP, ["attachments"], failing);
    } catch (caught) {
      error = caught;
    }
    const kept = join(home, "backups", `pre-restore-${STAMP}`);
    expect((error as Error).message).toBe(
      `restore failed while placing files (EBUSY); 2 move(s) could not be undone: your previous data is under ${kept}, and part of the restored files may already be in place`,
    );
    expect(read(join(kept, "attachments/a"))).toBe("old-a");
  });

  it("refuses a backups folder on another file system before it snapshots or moves anything", () => {
    const shm = "/dev/shm";
    if (!existsSync(shm) || statSync(shm).dev === statSync(home).dev) return;
    const elsewhere = mkdtempSync(join(shm, "pap-place-"));
    try {
      symlinkSync(elsewhere, join(home, "backups"));
      expect(() => placeRestored(home, extracted, STAMP, ["attachments"])).toThrow(
        "must be on one file system",
      );
      expect(readdirSync(elsewhere)).toEqual([]);
      expect(read(join(home, "attachments/a"))).toBe("old-a");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("refuses a restore stage on another file system than the data folder", () => {
    const shm = "/dev/shm";
    if (!existsSync(shm) || statSync(shm).dev === statSync(home).dev) return;
    const stage = mkdtempSync(join(shm, "pap-stage-"));
    try {
      database(join(stage, "state.db"), "new");
      expect(() => placeRestored(home, stage, STAMP, [])).toThrow("must be on one file system");
      expect(marker(join(home, "state.db"))).toBe("old");
      expect(existsSync(join(home, "backups"))).toBe(false);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });
});
