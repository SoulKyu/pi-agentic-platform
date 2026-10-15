import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLaneBed, type LaneBed } from "../testing/lane-bed.ts";
import { captureCheckpoint, checkpointRef, restoreCheckpoint } from "./checkpoint.ts";

// Fix round 3: a lane folder is replaced by the target's file only when the undo capture held everything in it.
let lanes: LaneBed;
beforeEach(() => {
  lanes = createLaneBed();
});
afterEach(() => lanes.dispose());

const capture = (path: string, gitDir: string, key: "root" | "undo") =>
  captureCheckpoint(lanes.git, path, gitDir, lanes.indexDir, checkpointRef("demo-0a1b", key));
const summary = (left: ReadonlyArray<{ path: Buffer; reason: string }>) =>
  left.map((entry) => [entry.path.toString(), entry.reason]);

/** The target holds a file `x`; the lane holds a folder `x`. */
async function folderWhereTargetHasFile(name: string, fill: (path: string) => void) {
  const { path, gitDir } = await lanes.lane(name);
  writeFileSync(join(path, ".gitignore"), "*.env\n");
  lanes.bed.git(path, "add", ".gitignore");
  lanes.bed.git(path, "commit", "-q", "-m", "ignore");
  writeFileSync(join(path, "x"), "file x\n");
  const target = await capture(path, gitDir, "root");
  rmSync(join(path, "x"));
  mkdirSync(join(path, "x"));
  fill(path);
  const undo = await capture(path, gitDir, "undo");
  return { path, gitDir, target, undo };
}

describe("a folder where the target has a file (N3)", () => {
  it("is kept with an ignored file in it, and the clash is reported", async () => {
    const { path, gitDir, target, undo } = await folderWhereTargetHasFile("ignored", (lane) => {
      writeFileSync(join(lane, "x", "s.txt"), "s\n");
      writeFileSync(join(lane, "x", "secret.env"), "KEY=1\n");
    });
    expect(undo.left).toEqual([]);
    const done = await restoreCheckpoint(lanes.git, path, gitDir, target.commit, undo);
    expect(statSync(join(path, "x")).isDirectory()).toBe(true);
    expect(readFileSync(join(path, "x", "secret.env"), "utf8")).toBe("KEY=1\n");
    expect(readFileSync(join(path, "x", "s.txt"), "utf8")).toBe("s\n");
    expect(summary(done.left)).toEqual([
      ["x", "conflict"],
      ["x/secret.env", "ignored"],
    ]);
  });

  it("is replaced when undo held everything in it, and undoing the restore brings it back exactly", async () => {
    const { path, gitDir, target, undo } = await folderWhereTargetHasFile("held", (lane) => {
      mkdirSync(join(lane, "x", "sub"));
      writeFileSync(join(lane, "x", "a.txt"), "a\n");
      writeFileSync(join(lane, "x", "sub", "b.txt"), "b\n");
    });
    const done = await restoreCheckpoint(lanes.git, path, gitDir, target.commit, undo);
    expect(done.left).toEqual([]);
    expect(readFileSync(join(path, "x"), "utf8")).toBe("file x\n");

    const second = await capture(path, gitDir, "undo");
    await restoreCheckpoint(lanes.git, path, gitDir, undo.commit, second);
    expect(readFileSync(join(path, "x", "a.txt"), "utf8")).toBe("a\n");
    expect(readFileSync(join(path, "x", "sub", "b.txt"), "utf8")).toBe("b\n");
    expect(existsSync(join(path, "x", "sub"))).toBe(true);
  });

  it("counts a folder over the walk bound as a conflict", async () => {
    const { path, gitDir, target, undo } = await folderWhereTargetHasFile("bound", (lane) => {
      for (const name of ["1", "2", "3"]) writeFileSync(join(lane, "x", `${name}.txt`), `${name}\n`);
    });
    const done = await restoreCheckpoint(lanes.git, path, gitDir, target.commit, undo, 2);
    expect(statSync(join(path, "x")).isDirectory()).toBe(true);
    expect(readFileSync(join(path, "x", "3.txt"), "utf8")).toBe("3\n");
    expect(summary(done.left)).toEqual([["x", "conflict"]]);
    const within = await restoreCheckpoint(lanes.git, path, gitDir, target.commit, undo, 3);
    expect(within.left).toEqual([]);
    expect(readFileSync(join(path, "x"), "utf8")).toBe("file x\n");
  });
});
