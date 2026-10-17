import * as childProcess from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireInstanceLock } from "../../kernel/home.ts";
import { processStart } from "../ops/op-lock.ts";
import { knownMigrationIds } from "../ops/schema-status.ts";
import { backupOf, craft, makeDb, makeHome, NOW, PASSPHRASE, treeOf } from "../testing/restore-kit.ts";
import {
  END,
  fileMember,
  hiddenSymlink,
  rawHeader,
  smuggleArchive,
  writeGzTar,
} from "../testing/tar-fixtures.ts";
import { restoreBackup, RestoreError, type RestoreDeps } from "./restore.ts";
import { listMembers, RESTORE_LIMITS, type Member } from "./tar-list.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

let scratch: string;
let home: string;
let piDir: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-restore-ref-"));
  home = join(scratch, "home");
  piDir = join(scratch, "pi");
  mkdirSync(piDir);
  makeHome(home, ["old"], { "agents/old/keep.txt": "kept" });
  rmSync(join(home, "state.db"));
  rmSync(join(home, "agents"), { recursive: true });
});
afterEach(() => {
  chmodSync(scratch, 0o700);
  rmSync(scratch, { recursive: true, force: true });
});

const deps = (file: string, over: Partial<RestoreDeps> = {}): RestoreDeps => ({
  home,
  piDir,
  file,
  replace: false,
  now: NOW,
  passphrase: async () => PASSPHRASE,
  ...over,
});

/** The refusal is a RestoreError with this text and the home is byte-identical afterwards. */
async function refused(
  file: string,
  message: string | RegExp,
  over: Partial<RestoreDeps> = {},
): Promise<void> {
  const before = treeOf(home);
  const error = await restoreBackup(deps(file, over)).then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(RestoreError);
  expect((error as Error).message).toMatch(message);
  expect(treeOf(home)).toEqual(before);
  expect(existsSync(join(home, "update", "op.lock"))).toBe(false);
  expect(existsSync(join(home, "pap.lock"))).toBe(false);
}

const trimEnd = (tar: Buffer): Buffer => {
  let end = tar.length;
  while (end >= 512 && tar.subarray(end - 512, end).every((byte) => byte === 0)) end -= 512;
  return tar.subarray(0, end);
};

const WHAT_THE_STUB_SAYS: Member[] = [
  { path: "manifest.json", kind: "file", size: 1 },
  { path: "state.db", kind: "file", size: 1 },
  { path: "agents", kind: "dir", size: 0 },
  { path: "agents/a", kind: "file", size: 0 },
  { path: "agents/x", kind: "file", size: 1 },
];
const stubbedReader = async (): Promise<Member[]> => WHAT_THE_STUB_SAYS;

/** A restorable archive (manifest and database made by `craft`) followed by the members of `smuggle`, GNU tar's way. */
function withSmuggled(
  name: string,
  smuggle: (archive: string) => void,
  tamper?: (tar: Buffer) => void,
): string {
  const first = craft(scratch, `${name}-first`, { manifest: { tops: ["agents"] } });
  const second = join(scratch, `${name}-second.tar.gz`);
  smuggle(second);
  const tail = trimEnd(gunzipSync(readFileSync(second)));
  tamper?.(tail);
  const file = join(scratch, `${name}.tar.gz`);
  writeFileSync(file, gzipSync(Buffer.concat([trimEnd(gunzipSync(readFileSync(first))), tail, END])));
  return file;
}

const anywhereNamed = (root: string, name: string): boolean =>
  readdirSync(root, { recursive: true }).some((entry) => String(entry).split("/").includes(name));

describe("pap restore refuses, one row of M6bR7 at a time, and leaves the home as it was", () => {
  it("refuses while another operation holds update/op.lock", async () => {
    writeFileSync(join(home, "update", "op.lock"), `${process.pid} ${processStart(process.pid)}\n`);
    const file = craft(scratch, "ok");
    const before = treeOf(home);
    await expect(restoreBackup(deps(file))).rejects.toThrow(
      /another pap update, rollback, recover or restore is running/,
    );
    expect(treeOf(home)).toEqual(before);
  });

  it("refuses while the daemon holds the instance lock, before the passphrase is asked, and frees the operation lock", async () => {
    const source = join(scratch, "source");
    makeHome(source, ["a"]);
    const file = await backupOf(source, piDir, join(scratch, "out"), { encrypt: true });
    const asked = vi.fn(async () => PASSPHRASE);
    const lock = acquireInstanceLock(home);
    try {
      await expect(restoreBackup(deps(file, { passphrase: asked }))).rejects.toThrow(
        /pap is already running/,
      );
      expect(asked).not.toHaveBeenCalled();
      expect(existsSync(join(home, "update", "op.lock"))).toBe(false);
    } finally {
      lock.release();
    }
  });

  it("refuses an existing state.db without --replace", async () => {
    makeDb(join(home, "state.db"), ["old"]);
    await refused(craft(scratch, "ok"), /state\.db already exists .*--replace/);
  });

  it("refuses a file that is not a backup", async () => {
    const junk = join(scratch, "junk.tar.gz");
    writeFileSync(junk, "this is not a backup");
    await refused(junk, /^the archive is not a readable gzip tar$/);
  });

  it("refuses format 2", async () => {
    await refused(craft(scratch, "f2", { manifest: { format: 2 } }), /format 2.*newer pap/);
  });

  it("refuses a papVersion that would put an escape sequence on the terminal", async () => {
    const file = craft(scratch, "escape", { manifest: { papVersion: "\u001b[31m x" } });
    await refused(file, /^the backup manifest is not one this pap understands/);
  });

  it("refuses a manifest with an unknown key", async () => {
    await refused(
      craft(scratch, "key", { manifest: { extra: true } }),
      /manifest is not one this pap understands/,
    );
  });

  it("refuses a database with an id this build does not know (newer pap)", async () => {
    const db = join(scratch, "newer.db");
    makeDb(db, ["x"], [...knownMigrationIds(), "kernel/299912312359_future.sql"]);
    await refused(craft(scratch, "newer", { db }), /written by a newer pap/);
  });

  it("refuses a damaged database whose checksum the manifest records", async () => {
    const db = join(scratch, "damaged.db");
    writeFileSync(db, Buffer.from("SQLite format 3\0".padEnd(4096, "x")));
    await refused(
      craft(scratch, "damaged", { db, manifest: { schema: [...knownMigrationIds()] } }),
      /database in the backup is damaged/,
    );
  });

  it("refuses a database that does not match the manifest checksum", async () => {
    await refused(
      craft(scratch, "sum", { manifest: { stateDb: { sha256: "0".repeat(64), bytes: 1 } } }),
      /does not match/,
    );
  });

  it("refuses a manifest and a database that disagree on the migration ids", async () => {
    const ids = [...knownMigrationIds()];
    await refused(craft(scratch, "disagree", { manifest: { schema: ids.slice(1) } }), /disagree/);
  });

  it("refuses secrets/ in the archive when the manifest says excluded", async () => {
    const file = craft(scratch, "secrets", {
      files: { "secrets/vault/key": "k" },
      manifest: { secrets: "excluded", tops: [] },
    });
    await refused(file, /secrets/);
  });

  it("refuses a member that climbs out of the folder", async () => {
    const file = join(scratch, "climb.tar.gz");
    writeGzTar(file, [rawHeader({ name: "agents/../x", size: 0 })]);
    await refused(file, /path that is not safe/);
  });

  it("refuses a folder the manifest does not list", async () => {
    await refused(
      craft(scratch, "unlisted", { files: { "agents/f": "x" }, manifest: { tops: [] } }),
      /folder that its manifest does not list/,
    );
  });

  it("refuses when tar extracts a name the listing did not contain (reader stubbed to say less)", async () => {
    const file = craft(scratch, "more", { files: { "agents/f": "x" } });
    await refused(file, /extracted files differ from the listing/, {
      list: async () => WHAT_THE_STUB_SAYS.filter((member) => !member.path.startsWith("agents")),
    });
  });

  it("refuses a symbolic link member", async () => {
    await refused(
      craft(scratch, "link", { files: { "agents/f": "x" }, links: { "agents/l": "/etc" } }),
      /link/,
    );
  });

  it("refuses a top-level name the backup never writes", async () => {
    await refused(
      craft(scratch, "top", { files: { "worktrees/x": "x" } }),
      /folder this pap does not restore/,
    );
  });

  it("refuses an input that is a symbolic link", async () => {
    const real = craft(scratch, "ok");
    const link = join(scratch, "link.tar.gz");
    symlinkSync(real, link);
    await refused(link, /symbolic link/);
  });

  it("refuses a missing file", async () => {
    await refused(join(scratch, "nothing.tar.gz"), /no such backup file/);
  });

  it("refuses when free space is below the declared bytes, the copy and 64 MB, before any extraction", async () => {
    vi.mocked(childProcess.spawn).mockClear();
    await refused(craft(scratch, "ok"), /not enough free space.*1 MB free.*MB needed/, { freeMb: () => 1 });
    expect(vi.mocked(childProcess.spawn)).not.toHaveBeenCalled();
  });

  it("refuses a wrong passphrase on an encrypted backup and writes nothing", async () => {
    const source = join(scratch, "source");
    makeHome(source, ["a"]);
    const file = await backupOf(source, piDir, join(scratch, "out"), { encrypt: true });
    await refused(file, /wrong passphrase, or the backup was changed or damaged/, {
      passphrase: async () => "not the passphrase",
    });
  });
});

describe("a hostile archive that the reader refuses, and that the walk refuses when the reader is stubbed (M6b-RT-01)", () => {
  const elsewhere = (): string => {
    const target = join(scratch, "elsewhere");
    mkdirSync(target);
    return target;
  };

  it("the reader refuses the hidden symlink; no link or file lands anywhere", async () => {
    const target = elsewhere();
    const file = withSmuggled("hidden", (out) => smuggleArchive(scratch, out, hiddenSymlink(target)));
    await refused(file, /extended header record this reader does not accept/);
    expect(anywhereNamed(home, "evil")).toBe(false);
    expect(readdirSync(target)).toEqual([]);
  });

  it("with the reader stubbed, the walk refuses the extracted link and the home is untouched", async () => {
    const target = elsewhere();
    const file = withSmuggled("hidden-stub", (out) => smuggleArchive(scratch, out, hiddenSymlink(target)));
    await refused(file, /^tar could not extract the backup \(exit 2\)$/, {
      list: stubbedReader,
    });
    expect(anywhereNamed(home, "evil")).toBe(false);
    expect(readdirSync(target)).toEqual([]);
  });

  it("a link-only archive (tar exits 0) is refused by the walk, and nothing chmods through the link first", async () => {
    const target = join(scratch, "victim.txt");
    writeFileSync(target, "v");
    chmodSync(target, 0o644);
    const file = withSmuggled("link-only", (out) =>
      smuggleArchive(scratch, out, rawHeader({ name: "agents/evil", type: "2", linkname: target })),
    );
    await refused(file, /the archive was not restored: the extracted tree holds a link/, {
      list: stubbedReader,
    });
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });

  it("the NBSP-checksum archive is refused by the reader, and by tar's exit status or the walk when the reader is stubbed", async () => {
    const target = elsewhere();
    const nbsp = (tail: Buffer): void => {
      for (let at = 0; at + 512 <= tail.length; at += 512) {
        if (tail.subarray(at, at + 9).toString("latin1") === "agents/x\0") {
          Buffer.concat([Buffer.from([0xc2, 0xa0]), tail.subarray(at + 148, at + 154)]).copy(tail, at + 148);
          return;
        }
      }
      throw new Error("header not found");
    };
    const file = withSmuggled("nbsp", (out) => smuggleArchive(scratch, out, hiddenSymlink(target), []), nbsp);
    await refused(file, /unreadable tar header/);
    await refused(file, /^tar could not extract the backup \(exit 2\)$/, { list: stubbedReader });
    expect(anywhereNamed(home, "evil")).toBe(false);
    expect(readdirSync(target)).toEqual([]);
  });

  it("an extracted folder nobody can read gets a fixed message, no path, and the stage is still removed", async () => {
    const file = join(scratch, "locked.tar.gz");
    writeGzTar(file, [rawHeader({ name: "agents", type: "5", mode: 0 }), fileMember("agents/f", "x")]);
    await refused(file, /^the archive was not restored: the extracted tree could not be read \(EACCES\)$/, {
      list: stubbedReader,
    });
    expect(readdirSync(join(home, "tmp"))).toEqual([]);
  });

  it("a stage that cannot be removed is a warning, and the restore still succeeds", async () => {
    const file = craft(scratch, "stuck", { files: { "agents/f": "x" }, manifest: { tops: ["agents"] } });
    const tmp = join(home, "tmp");
    try {
      const result = await restoreBackup(
        deps(file, {
          list: async (path) => {
            chmodSync(tmp, 0o500); // the stage cannot be unlinked from a read-only parent
            return listMembers(path, RESTORE_LIMITS);
          },
        }),
      );
      expect(result.warnings.join("\n")).toMatch(/restore stage .* could not be removed: delete it by hand/);
    } finally {
      chmodSync(tmp, 0o700);
    }
  });

  it("a non-zero tar exit refuses before the walk (reader stubbed, every member extracted)", async () => {
    const file = craft(scratch, "cut", {
      files: { "agents/a": "", "agents/x": "x" },
      manifest: { tops: ["agents"] },
    });
    truncateSync(file, statSync(file).size - 8); // the gzip trailer: tar writes every member, then exits 2
    await refused(file, /^tar could not extract the backup \(exit /, { list: stubbedReader });
  });
});
