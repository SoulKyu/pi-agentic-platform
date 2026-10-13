import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createScanEngine, type ScanEngine } from "./scanner-engine.ts";
import type { FileContext } from "./scanner-file.ts";
import { type FakeWatch, fakeWatch } from "./testing/fake-watch.ts";

let agentDir = "";
let root = "";
let folder = "";
let watch: FakeWatch;
let engine: ScanEngine | undefined;
let requestReconcile: Mock<() => void>;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pap-engine-dirs-"));
  root = join(agentDir, "sessions");
  folder = join(root, "--w--");
  mkdirSync(folder, { recursive: true });
  watch = fakeWatch();
  requestReconcile = vi.fn<() => void>();
});
afterEach(async () => {
  await engine?.close();
  engine = undefined;
  rmSync(agentDir, { recursive: true, force: true });
});

function make(factory: FakeWatch["factory"] = watch.factory): ScanEngine {
  engine = createScanEngine({
    root,
    ctx: {} as FileContext,
    watch: factory,
    clock: createFakeClock(),
    logger: silentLogger,
    say: () => undefined,
    requestReconcile,
    onDamaged: () => undefined,
    process: () => ({ kind: "gone" }),
    yieldNow: () => Promise.resolve(),
  });
  return engine;
}

describe("watchers of folders that disappear", () => {
  it("a deleted folder's watcher is closed and evicted, and the folder created again is watched anew", () => {
    const e = make();
    e.watchRoot();
    e.watchFolder(folder);
    rmSync(folder, { recursive: true });
    watch.emit(folder, null);
    expect(watch.closed).toEqual([folder]);
    expect(watch.open()).toEqual([root]);
    mkdirSync(folder);
    watch.emit(root, "--w--");
    expect(watch.open().sort()).toEqual([folder, root].sort());
    expect(watch.watched.filter((dir) => dir === folder)).toHaveLength(2);
  });

  it("a folder created again whose removal was never seen gets a fresh watcher", () => {
    const e = make();
    e.watchRoot();
    e.watchFolder(folder);
    watch.emit(root, "--w--");
    expect(watch.closed).toEqual([folder]);
    expect(watch.watched.filter((dir) => dir === folder)).toHaveLength(2);
  });

  it("an eviction frees a slot of the 512", () => {
    const e = make();
    for (let i = 0; i < 512; i += 1) e.watchFolder(join(root, `--f${i}--`));
    e.watchFolder(folder);
    expect(watch.open()).not.toContain(folder);
    e.unwatch(join(root, "--f0--"));
    e.watchFolder(folder);
    expect(watch.open()).toContain(folder);
  });

  it("a deleted root falls back to its parent, and the root created again is watched", () => {
    const e = make();
    e.watchRoot();
    rmSync(root, { recursive: true });
    watch.emit(root, null);
    expect(watch.closed).toEqual([root]);
    expect(watch.open()).toEqual([agentDir]);
    expect(requestReconcile).toHaveBeenCalledTimes(1);
    mkdirSync(root);
    watch.emit(agentDir, "sessions");
    expect(watch.open()).toEqual([root]);
  });

  it("a root created between the check and the watch of its parent is watched at once", () => {
    rmSync(root, { recursive: true });
    const e = make((dir, onEvent, onError) => {
      if (dir === agentDir) mkdirSync(root);
      return watch.factory(dir, onEvent, onError);
    });
    e.watchRoot();
    expect(watch.open()).toEqual([root]);
  });
});
