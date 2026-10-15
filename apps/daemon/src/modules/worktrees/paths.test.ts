import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { laneFolder, removeLaneFolder } from "./paths.ts";

let dir: string;
let papHome: string;
let root: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pap-paths-")));
  papHome = join(dir, "pap");
  root = join(papHome, "worktrees");
  mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("laneFolder (M9R16)", () => {
  it("joins the real pap home, worktrees and the lane id", () => {
    expect(laneFolder(papHome, "fix-bug-1a2b")).toBe(join(root, "fix-bug-1a2b"));
  });

  it("refuses a name that is not a lane id", () => {
    expect(() => laneFolder(papHome, "../x-1a2b")).toThrow("not a lane id");
    expect(() => laneFolder(papHome, "x")).toThrow("not a lane id");
  });
});

describe("removeLaneFolder", () => {
  it("removes a lane folder holding a symlink to an outside file, which survives", async () => {
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "keep");
    const lane = join(root, "fix-bug-1a2b");
    mkdirSync(lane);
    writeFileSync(join(lane, "a.txt"), "x");
    symlinkSync(outside, join(lane, "link"));
    expect(await removeLaneFolder(papHome, lane)).toBe(true);
    expect(existsSync(lane)).toBe(false);
    expect(existsSync(outside)).toBe(true);
  });

  it("answers true when the folder is already gone", async () => {
    expect(await removeLaneFolder(papHome, join(root, "fix-bug-1a2b"))).toBe(true);
  });

  it("refuses a path outside worktrees", async () => {
    const other = join(dir, "other-1a2b");
    mkdirSync(other);
    expect(await removeLaneFolder(papHome, other)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it("refuses a nested path", async () => {
    const nested = join(root, "fix-bug-1a2b", "inner-1a2b");
    mkdirSync(nested, { recursive: true });
    expect(await removeLaneFolder(papHome, nested)).toBe(false);
    expect(existsSync(nested)).toBe(true);
  });

  it("refuses a name that is not a lane id", async () => {
    const odd = join(root, "notalane");
    mkdirSync(odd);
    expect(await removeLaneFolder(papHome, odd)).toBe(false);
    expect(existsSync(odd)).toBe(true);
  });

  it("refuses a lane folder below a symlinked worktrees folder and removes nothing (T3-2)", async () => {
    const target = join(dir, "target");
    mkdirSync(join(target, "fix-bug-1a2b"), { recursive: true });
    writeFileSync(join(target, "fix-bug-1a2b", "precious.txt"), "keep");
    rmSync(root, { recursive: true });
    symlinkSync(target, root);
    expect(await removeLaneFolder(papHome, join(root, "fix-bug-1a2b"))).toBe(false);
    expect(existsSync(join(target, "fix-bug-1a2b", "precious.txt"))).toBe(true);
  });

  it("refuses a symlink named like a lane and keeps its target", async () => {
    const target = join(dir, "target");
    mkdirSync(target);
    writeFileSync(join(target, "precious.txt"), "keep");
    const link = join(root, "fix-bug-1a2b");
    symlinkSync(target, link);
    expect(await removeLaneFolder(papHome, link)).toBe(false);
    expect(existsSync(join(target, "precious.txt"))).toBe(true);
  });

  it("refuses a file named like a lane", async () => {
    const file = join(root, "fix-bug-1a2b");
    writeFileSync(file, "x");
    expect(await removeLaneFolder(papHome, file)).toBe(false);
    expect(existsSync(file)).toBe(true);
  });
});
