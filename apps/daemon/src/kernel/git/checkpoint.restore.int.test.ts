import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLaneBed, type LaneBed } from "../testing/lane-bed.ts";
import { captureCheckpoint, checkpointRef, restoreCheckpoint } from "./checkpoint.ts";

// Fix round 1 (task-11-review C1, I1): a restore deletes only what the undo capture held, and one file never sinks a capture.
let lanes: LaneBed;
beforeEach(() => {
  lanes = createLaneBed();
});
afterEach(() => lanes.dispose());

const BIG = 51 * 1024 * 1024;
const LATIN = Buffer.from("caf\xe9.txt", "latin1");
const inLane = (path: string, name: string | Buffer): Buffer =>
  Buffer.concat([Buffer.from(`${path}/`), Buffer.from(name as string)]);

async function capture(path: string, gitDir: string, key: "root" | "undo" | { entryId: string }) {
  const ref = checkpointRef("demo-0a1b", key);
  const made = await captureCheckpoint(lanes.git, path, gitDir, lanes.indexDir, ref);
  await lanes.git.run(path, ["update-ref", "--no-deref", ref, made.commit], { gitDir });
  return made;
}
async function restore(path: string, gitDir: string, commit: string) {
  const undo = await capture(path, gitDir, "undo");
  return { undo, ...(await restoreCheckpoint(lanes.git, path, gitDir, commit, undo)) };
}
/** The names in a tree, as raw bytes. */
const names = (path: string, oid: string): Buffer[] =>
  execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", oid], { cwd: path, env: lanes.bed.setupEnv() })
    .toString("latin1")
    .split("\0")
    .filter(Boolean)
    .map((name) => Buffer.from(name, "latin1"));
const has = (list: Buffer[], name: string | Buffer): boolean =>
  list.some((entry) => entry.equals(Buffer.from(name as string)));

describe("a restore never deletes what undo did not hold (C1)", () => {
  it("keeps an untracked file over the size limit that existed before the checkpoint", async () => {
    const { path, gitDir } = await lanes.lane("big");
    writeFileSync(join(path, "dev.db"), "");
    truncateSync(join(path, "dev.db"), BIG);
    const root = await capture(path, gitDir, "root");
    expect(root.left).toEqual([{ path: Buffer.from("dev.db"), reason: "large" }]);
    writeFileSync(join(path, "later.txt"), "later\n");

    const done = await restore(path, gitDir, root.commit);
    expect(existsSync(join(path, "dev.db"))).toBe(true);
    expect(existsSync(join(path, "later.txt"))).toBe(false);
    expect(done.left).toEqual([{ path: Buffer.from("dev.db"), reason: "large" }]);
  });

  it("keeps a file whose name is not UTF-8, and holds it in the checkpoint", async () => {
    const { path, gitDir } = await lanes.lane("latin");
    writeFileSync(inLane(path, LATIN), "latin\n");
    const root = await capture(path, gitDir, "root");
    expect(has(names(path, root.tree), LATIN)).toBe(true);
    expect(root.skipped).toBe(0);
    await restore(path, gitDir, root.commit);
    expect(readFileSync(inLane(path, LATIN), "utf8")).toBe("latin\n");
  });

  it("keeps a .env that a tracked .gitignore, reverted by the restore, ignored after the checkpoint", async () => {
    const { path, gitDir } = await lanes.lane("env");
    writeFileSync(join(path, ".gitignore"), "*.log\n");
    lanes.bed.git(path, "add", ".gitignore");
    lanes.bed.git(path, "commit", "-q", "-m", "ignore");
    const root = await capture(path, gitDir, "root");
    writeFileSync(join(path, ".gitignore"), "*.log\n.env\n");
    writeFileSync(join(path, ".env"), "KEY=1\n");
    await restore(path, gitDir, root.commit);
    expect(readFileSync(join(path, ".gitignore"), "utf8")).toBe("*.log\n");
    expect(readFileSync(join(path, ".env"), "utf8")).toBe("KEY=1\n");
  });

  it("removes only what undo held and the target lacks, and leaves a folder that still holds a kept file", async () => {
    const { path, gitDir } = await lanes.lane("folder");
    const root = await capture(path, gitDir, "root");
    mkdirSync(join(path, "mixed"));
    writeFileSync(join(path, "mixed", "mine.txt"), "mine\n");
    writeFileSync(join(path, "mixed", "big.bin"), "");
    truncateSync(join(path, "mixed", "big.bin"), BIG);
    const done = await restore(path, gitDir, root.commit);
    expect(existsSync(join(path, "mixed", "mine.txt"))).toBe(false);
    expect(existsSync(join(path, "mixed", "big.bin"))).toBe(true);
    expect(done.left.map((entry) => entry.path.toString())).toEqual(["mixed/big.bin"]);
  });

  it("never follows a symlink that took the place of a folder when it removes", async () => {
    const { path, gitDir } = await lanes.lane("link");
    const root = await capture(path, gitDir, "root");
    mkdirSync(join(path, "dir"));
    writeFileSync(join(path, "dir", "victim.txt"), "v\n");
    const outside = join(lanes.bed.dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "victim.txt"), "outside\n");
    const undo = await capture(path, gitDir, "undo");
    rmSync(join(path, "dir"), { recursive: true });
    symlinkSync(outside, join(path, "dir"));
    await restoreCheckpoint(lanes.git, path, gitDir, root.commit, undo);
    expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("outside\n");
  });

  it("is undone exactly: restoring undo brings back what the restore removed", async () => {
    const { path, gitDir } = await lanes.lane("roundtrip");
    const root = await capture(path, gitDir, "root");
    writeFileSync(join(path, "a.txt"), "edited\n");
    writeFileSync(join(path, "after.txt"), "after\n");
    mkdirSync(join(path, "newdir"));
    writeFileSync(join(path, "newdir", "f.txt"), "f\n");
    writeFileSync(inLane(path, LATIN), "latin\n");
    const first = await restore(path, gitDir, root.commit);
    expect(first.removed).toBe(3);
    expect(existsSync(join(path, "after.txt"))).toBe(false);

    await restore(path, gitDir, first.undo.commit);
    expect(readFileSync(join(path, "a.txt"), "utf8")).toBe("edited\n");
    expect(readFileSync(join(path, "after.txt"), "utf8")).toBe("after\n");
    expect(readFileSync(join(path, "newdir", "f.txt"), "utf8")).toBe("f\n");
    expect(readFileSync(inLane(path, LATIN), "utf8")).toBe("latin\n");
  });
});

describe("one file never sinks a capture (I1)", () => {
  it("stages a tracked folder replaced by a symlink as the symlink, not as a pathspec beyond it", async () => {
    const { path, gitDir } = await lanes.lane("replaced");
    mkdirSync(join(path, "cfg"));
    writeFileSync(join(path, "cfg", "a.txt"), "a\n");
    writeFileSync(join(path, "cfg", "b.txt"), "b\n");
    lanes.bed.git(path, "add", "cfg");
    lanes.bed.git(path, "commit", "-q", "-m", "cfg");
    const shared = join(lanes.bed.dir, "shared");
    mkdirSync(shared);
    writeFileSync(join(shared, "a.txt"), "shared\n");
    rmSync(join(path, "cfg"), { recursive: true });
    symlinkSync(shared, join(path, "cfg"));
    const made = await capture(path, gitDir, "root");
    expect(made.skipped).toBe(0);
    expect(lanes.bed.git(path, "ls-tree", made.tree, "cfg").trim()).toMatch(/^120000 blob [0-9a-f]+\tcfg$/);
    expect(has(names(path, made.tree), "cfg/a.txt")).toBe(false);
  });

  it("leaves an unreadable file out with the reason unreadable and goes on", async () => {
    if (process.getuid?.() === 0) return;
    const { path, gitDir } = await lanes.lane("unreadable");
    writeFileSync(join(path, "secret.key"), "k\n");
    chmodSync(join(path, "secret.key"), 0o000);
    writeFileSync(join(path, "fine.txt"), "f\n");
    writeFileSync(join(path, "a.txt"), "changed\n");
    chmodSync(join(path, "a.txt"), 0o000);
    try {
      const made = await capture(path, gitDir, "root");
      expect(made.left.map((entry) => [entry.path.toString(), entry.reason]).sort()).toEqual([
        ["a.txt", "unreadable"],
        ["secret.key", "unreadable"],
      ]);
      expect(has(names(path, made.tree), "fine.txt")).toBe(true);
      expect(has(names(path, made.tree), "secret.key")).toBe(false);
    } finally {
      chmodSync(join(path, "secret.key"), 0o600);
      chmodSync(join(path, "a.txt"), 0o600);
    }
  });

  it("stages a modified tracked file whose name is not UTF-8", async () => {
    const { path, gitDir } = await lanes.lane("tracked-latin");
    writeFileSync(inLane(path, LATIN), "one\n");
    lanes.bed.git(path, "add", ".");
    lanes.bed.git(path, "commit", "-q", "-m", "latin");
    writeFileSync(inLane(path, LATIN), "two\n");
    const made = await capture(path, gitDir, "root");
    expect(made.skipped).toBe(0);
    const listing = execFileSync("git", ["ls-tree", "-r", "-z", made.tree], {
      cwd: path,
      env: lanes.bed.setupEnv(),
    })
      .toString("latin1")
      .split("\0");
    const record = listing.find((line) => line.endsWith(`\t${LATIN.toString("latin1")}`)) ?? "";
    const blob = execFileSync("git", ["cat-file", "-p", record.split(/[ \t]/)[2] ?? ""], {
      cwd: path,
      env: lanes.bed.setupEnv(),
    });
    expect(blob.toString()).toBe("two\n");
  });

  it("applies the size limit to files under a folder that replaced a tracked file", async () => {
    const { path, gitDir } = await lanes.lane("file-to-folder");
    rmSync(join(path, "a.txt"));
    mkdirSync(join(path, "a.txt"));
    writeFileSync(join(path, "a.txt", "big.bin"), "");
    truncateSync(join(path, "a.txt", "big.bin"), BIG);
    writeFileSync(join(path, "a.txt", "small.txt"), "s\n");
    const made = await capture(path, gitDir, "root");
    const held = names(path, made.tree);
    expect(has(held, "a.txt/small.txt")).toBe(true);
    expect(has(held, "a.txt/big.bin")).toBe(false);
    expect(made.left).toEqual([{ path: Buffer.from("a.txt/big.bin"), reason: "large" }]);
  });
});
