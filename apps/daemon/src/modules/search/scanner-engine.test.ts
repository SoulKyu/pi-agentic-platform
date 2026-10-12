import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createScanEngine, type ScanEngine } from "./scanner-engine.ts";
import type { FileContext, FileOutcome } from "./scanner-file.ts";
import { type FakeWatch, fakeWatch } from "./testing/fake-watch.ts";

function gate(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}

const INDEXED: FileOutcome = { kind: "indexed", sessionId: "s", rows: 1, more: false };

let agentDir = "";
let root = "";
let folder = "";
let clock: FakeClock;
let watch: FakeWatch;
let engine: ScanEngine | undefined;
let processed: string[];
let say: Mock<(event: string, fields?: Record<string, unknown>) => void>;
let requestReconcile: Mock<() => void>;
let onDamaged: Mock<() => void>;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pap-engine-"));
  root = join(agentDir, "sessions");
  folder = join(root, "--w--");
  mkdirSync(folder, { recursive: true });
  clock = createFakeClock();
  watch = fakeWatch();
  processed = [];
  say = vi.fn<(event: string, fields?: Record<string, unknown>) => void>();
  requestReconcile = vi.fn<() => void>();
  onDamaged = vi.fn<() => void>();
});
afterEach(async () => {
  await engine?.close();
  engine = undefined;
  rmSync(agentDir, { recursive: true, force: true });
});

function make(
  options: {
    process?: (path: string) => FileOutcome;
    yieldNow?: () => Promise<void>;
    maxQueue?: number;
  } = {},
): ScanEngine {
  const run =
    options.process ??
    ((path: string): FileOutcome => {
      processed.push(path);
      return INDEXED;
    });
  engine = createScanEngine({
    root,
    ctx: {} as FileContext,
    watch: watch.factory,
    clock,
    logger: silentLogger,
    say,
    requestReconcile,
    onDamaged,
    process: run,
    yieldNow: options.yieldNow ?? (() => Promise.resolve()),
    ...(options.maxQueue === undefined ? {} : { maxQueue: options.maxQueue }),
  });
  return engine;
}

const codeError = (message: string, extra: object) => Object.assign(new Error(message), extra);

describe("debounce", () => {
  it("debounces a burst of events per file", async () => {
    const e = make();
    e.watchFolder(folder);
    for (let i = 0; i < 5; i += 1) {
      watch.emit(folder, "a.jsonl");
      await clock.advance(20);
    }
    await e.idle();
    expect(processed).toEqual([]);
    await clock.advance(250);
    await e.idle();
    expect(processed).toEqual([join(folder, "a.jsonl")]);
  });

  it("a file written every 200 ms is still read within a second of its first event", async () => {
    const e = make();
    e.watchFolder(folder);
    for (let t = 0; t < 2000; t += 200) {
      watch.emit(folder, "a.jsonl");
      await clock.advance(200);
    }
    await e.idle();
    expect(processed).toEqual([join(folder, "a.jsonl"), join(folder, "a.jsonl")]);
  });

  it("ignores files that are not .jsonl and asks a reconcile for a nameless event", async () => {
    const e = make();
    e.watchFolder(folder);
    watch.emit(folder, "notes.txt");
    expect(clock.pending()).toBe(0);
    watch.emit(folder, null);
    expect(requestReconcile).toHaveBeenCalledTimes(1);
    await e.idle();
  });

  it("past maxQueue pending paths a new path is not debounced and a reconcile is asked", async () => {
    const e = make({ maxQueue: 2 });
    e.debounce("/a.jsonl");
    e.debounce("/b.jsonl");
    e.debounce("/c.jsonl");
    expect(clock.pending()).toBe(2);
    expect(requestReconcile).toHaveBeenCalledTimes(1);
    e.debounce("/a.jsonl");
    expect(requestReconcile).toHaveBeenCalledTimes(1);
    await clock.advance(250);
    await e.idle();
    // `a` was debounced again, so its timer restarted after `b`'s.
    expect(processed).toEqual(["/b.jsonl", "/a.jsonl"]);
  });
});

describe("watchers", () => {
  it("a new folder is watched and a reconcile is asked", async () => {
    const e = make();
    e.watchRoot();
    const created = join(root, "--new--");
    mkdirSync(created);
    watch.emit(root, "--new--");
    expect(watch.open()).toContain(created);
    expect(requestReconcile).toHaveBeenCalledTimes(1);
    watch.emit(created, "b.jsonl");
    await clock.advance(250);
    await e.idle();
    expect(processed).toEqual([join(created, "b.jsonl")]);
  });

  it("without sessions/ it watches the agent folder, then the root once it appears", () => {
    rmSync(root, { recursive: true });
    const e = make();
    e.watchRoot();
    expect(watch.open()).toEqual([agentDir]);
    watch.emit(agentDir, "other");
    expect(watch.open()).toEqual([agentDir]);
    mkdirSync(root);
    watch.emit(agentDir, "sessions");
    expect(watch.open()).toEqual([root]);
    expect(watch.closed).toEqual([agentDir]);
    expect(requestReconcile).toHaveBeenCalledTimes(1);
  });

  it("a watcher error closes it and says why", () => {
    const e = make();
    e.watchFolder(folder);
    watch.fail(folder, "ENOSPC");
    expect(watch.open()).toEqual([]);
    expect(say).toHaveBeenCalledWith("session_watch_failed", { code: "ENOSPC" });
    e.watchFolder(folder);
    expect(watch.open()).toEqual([folder]);
  });

  it("a refused watch is said and leaves the folder to the reconcile", () => {
    const e = make();
    watch.refuse.add(folder);
    e.watchFolder(folder);
    expect(say).toHaveBeenCalledWith("session_watch_failed", { code: "EMFILE" });
    expect(watch.open()).toEqual([]);
  });

  it("past 512 folders it watches no more and says so", () => {
    const e = make();
    for (let i = 0; i < 513; i += 1) e.watchFolder(join(root, `--f${i}--`));
    expect(watch.open()).toHaveLength(512);
    expect(say).toHaveBeenCalledWith("session_watch_limit", { max: 512 });
  });

  it("a symlinked folder is not followed", () => {
    const other = mkdtempSync(join(tmpdir(), "pap-engine-other-"));
    try {
      symlinkSync(other, join(root, "link"));
      const e = make();
      e.watchRoot();
      watch.emit(root, "link");
      expect(watch.open()).toEqual([root]);
      expect(requestReconcile).not.toHaveBeenCalled();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("an exception in a watch callback stays inside it", () => {
    requestReconcile.mockImplementation(() => {
      throw new Error("boom");
    });
    const e = make();
    e.watchFolder(folder);
    expect(() => watch.emit(folder, null)).not.toThrow();
    expect(say).toHaveBeenCalledWith("session_watch_callback_failed", { code: "error" });
  });
});

describe("queue and pump", () => {
  it("a full queue drops newcomers and asks a reconcile", async () => {
    const hold = gate();
    const e = make({ maxQueue: 2, yieldNow: () => hold.promise });
    for (const name of ["a", "b", "c", "d"]) e.enqueue(`/${name}.jsonl`);
    // `a` is running (out of the queue), `b` and `c` wait, `d` is dropped.
    expect(say).toHaveBeenCalledWith("session_queue_full", { max: 2 });
    expect(requestReconcile).toHaveBeenCalledTimes(1);
    hold.resolve();
    await e.idle();
    expect(processed).toEqual(["/a.jsonl", "/b.jsonl", "/c.jsonl"]);
  });

  it("a file answering more goes back to the end of the queue", async () => {
    let first = true;
    const hold = gate();
    let yields = 0;
    const e = make({
      yieldNow: () => (yields++ === 0 ? hold.promise : Promise.resolve()),
      process: (path) => {
        processed.push(path);
        const more = path === "/a.jsonl" && first;
        if (more) first = false;
        return { ...INDEXED, more };
      },
    });
    // The pump starts at once: `x` runs while `a` and `b` are queued behind it.
    e.enqueue("/x.jsonl");
    e.enqueue("/a.jsonl");
    e.enqueue("/b.jsonl");
    hold.resolve();
    await e.idle();
    expect(processed).toEqual(["/x.jsonl", "/a.jsonl", "/b.jsonl", "/a.jsonl"]);
  });

  it("a throwing step is said and the pump goes on", async () => {
    const e = make({
      process: (path) => {
        processed.push(path);
        if (path === "/a.jsonl") throw codeError("x", { code: "EIO" });
        return INDEXED;
      },
    });
    e.enqueue("/a.jsonl");
    e.enqueue("/b.jsonl");
    await e.idle();
    expect(processed).toEqual(["/a.jsonl", "/b.jsonl"]);
    expect(say).toHaveBeenCalledWith("session_scan_failed", { code: "EIO" });
    expect(onDamaged).not.toHaveBeenCalled();
  });

  it("a step that meets a damaged index asks for a rebuild", async () => {
    const e = make({
      process: (path) => {
        processed.push(path);
        if (path === "/a.jsonl") throw codeError("database disk image is malformed", { errcode: 11 });
        return INDEXED;
      },
    });
    e.enqueue("/a.jsonl");
    e.enqueue("/b.jsonl");
    await e.idle();
    expect(onDamaged).toHaveBeenCalledTimes(1);
    expect(processed).toEqual(["/a.jsonl", "/b.jsonl"]);
  });

  it("a say, a rebuild request or a reconcile request that throws does not stop the pump", async () => {
    say.mockImplementation(() => {
      throw new Error("say");
    });
    onDamaged.mockImplementation(() => {
      throw new Error("damaged");
    });
    const e = make({
      process: (path) => {
        processed.push(path);
        if (path === "/a.jsonl") throw codeError("database disk image is malformed", { errcode: 11 });
        return INDEXED;
      },
    });
    e.enqueue("/a.jsonl");
    e.enqueue("/b.jsonl");
    await e.idle();
    expect(processed).toEqual(["/a.jsonl", "/b.jsonl"]);
  });

  it("a failing yield is logged and a later enqueue starts the pump again", async () => {
    let fail = true;
    const e = make({
      yieldNow: () => (fail ? Promise.reject(new Error("yield")) : Promise.resolve()),
    });
    e.enqueue("/a.jsonl");
    await e.idle();
    fail = false;
    e.enqueue("/b.jsonl");
    await e.idle();
    expect(processed).toEqual(["/a.jsonl", "/b.jsonl"]);
  });
});

describe("close", () => {
  it("closes every watcher, clears every debounce and waits for the running step", async () => {
    const hold = gate();
    const e = make({ yieldNow: () => hold.promise });
    e.watchRoot();
    e.watchFolder(folder);
    e.enqueue("/a.jsonl");
    e.debounce("/b.jsonl");
    expect(clock.pending()).toBe(1);
    let closed = false;
    const closing = e.close().then(() => {
      closed = true;
    });
    await clock.advance(10);
    expect(closed).toBe(false);
    hold.resolve();
    await closing;
    expect(clock.pending()).toBe(0);
    expect(watch.open()).toEqual([]);
    expect(watch.closed.sort()).toEqual([folder, root].sort());
    e.debounce("/c.jsonl");
    e.enqueue("/c.jsonl");
    expect(clock.pending()).toBe(0);
    expect(processed).toEqual(["/a.jsonl"]);
  });
});
