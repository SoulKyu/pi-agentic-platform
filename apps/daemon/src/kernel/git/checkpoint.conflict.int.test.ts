import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLaneBed, type LaneBed } from "../testing/lane-bed.ts";
import { captureCheckpoint, checkpointRef, restoreCheckpoint } from "./checkpoint.ts";

// Fix round 2: a restore never destroys content the undo capture did not hold.
let lanes: LaneBed;
beforeEach(() => {
  lanes = createLaneBed();
});
afterEach(() => lanes.dispose());

const BIG = 51 * 1024 * 1024;
const capture = (path: string, gitDir: string, key: "root" | "undo") =>
  captureCheckpoint(lanes.git, path, gitDir, lanes.indexDir, checkpointRef("demo-0a1b", key));
const summary = (left: ReadonlyArray<{ path: Buffer; reason: string }>) =>
  left.map((entry) => [entry.path.toString(), entry.reason]);

describe("a left-in-place file is never overwritten or deleted by a restore", () => {
  it("keeps a folder, and its large file, where the target holds a file", async () => {
    const { path, gitDir } = await lanes.lane("conflict");
    writeFileSync(join(path, "x"), "file x\n");
    writeFileSync(join(path, "keep.txt"), "target\n");
    const target = await capture(path, gitDir, "root");
    rmSync(join(path, "x"));
    mkdirSync(join(path, "x"));
    writeFileSync(join(path, "x", "big.bin"), "");
    truncateSync(join(path, "x", "big.bin"), BIG);
    writeFileSync(join(path, "x", "s.txt"), "s\n");
    writeFileSync(join(path, "keep.txt"), "later\n");
    const undo = await capture(path, gitDir, "undo");
    expect(summary(undo.left)).toEqual([["x/big.bin", "large"]]);

    const done = await restoreCheckpoint(lanes.git, path, gitDir, target.commit, undo);
    expect(statSync(join(path, "x")).isDirectory()).toBe(true);
    expect(statSync(join(path, "x", "big.bin")).size).toBe(BIG);
    expect(readFileSync(join(path, "x", "s.txt"), "utf8")).toBe("s\n");
    expect(readFileSync(join(path, "keep.txt"), "utf8")).toBe("target\n");
    expect(summary(done.left)).toEqual([
      ["x/big.bin", "large"],
      ["x", "conflict"],
    ]);
  });

  it("does not overwrite a modified tracked file that undo could not read", async () => {
    if (process.getuid?.() === 0) return;
    const { path, gitDir } = await lanes.lane("unreadable");
    writeFileSync(join(path, "a.txt"), "zero\n");
    const target = await capture(path, gitDir, "root");
    writeFileSync(join(path, "a.txt"), "secret change\n");
    writeFileSync(join(path, "later.txt"), "later\n");
    chmodSync(join(path, "a.txt"), 0o000);
    try {
      const undo = await capture(path, gitDir, "undo");
      expect(summary(undo.left)).toEqual([["a.txt", "unreadable"]]);
      const done = await restoreCheckpoint(lanes.git, path, gitDir, target.commit, undo);
      expect(summary(done.left)).toEqual([["a.txt", "unreadable"]]);
      expect(existsSync(join(path, "later.txt"))).toBe(false);
    } finally {
      chmodSync(join(path, "a.txt"), 0o600);
    }
    expect(readFileSync(join(path, "a.txt"), "utf8")).toBe("secret change\n");
  });
});
