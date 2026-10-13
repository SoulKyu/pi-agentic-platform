import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import { openSearchIndex } from "./index-db.ts";
import { createSearchIndexStore, type FileCursor, type SearchIndexStore } from "./index-store.ts";
import { createScanner, type Scanner } from "./scanner.ts";
import type { FileOutcome } from "./scanner-file.ts";
import { type FakeWatch, fakeWatch } from "./testing/fake-watch.ts";
import { fakeScanPort } from "./testing/fake-scan-port.ts";

const SKIPPED: FileOutcome = { kind: "skipped", reason: "test" };
const nothing = (): Promise<void> => Promise.resolve();

let agentDir = "";
let root = "";
let folder = "";
let clock: FakeClock;
let watch: FakeWatch;
let db: Db;
let store: SearchIndexStore;
let scanner: Scanner | undefined;
let processed: string[];
let lines: Array<{ msg: string; fields: Record<string, unknown> | undefined }>;

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (msg, fields) => {
    lines.push({ msg, fields });
  },
  error: (msg, fields) => {
    lines.push({ msg, fields });
  },
  child: () => logger,
};

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pap-scanner-"));
  root = join(agentDir, "sessions");
  folder = join(root, "--w--");
  mkdirSync(folder, { recursive: true });
  clock = createFakeClock();
  watch = fakeWatch();
  db = openSearchIndex(join(agentDir, "search.db"), logger);
  store = createSearchIndexStore(db);
  processed = [];
  lines = [];
});
afterEach(async () => {
  await scanner?.stop();
  scanner = undefined;
  db.close();
  rmSync(agentDir, { recursive: true, force: true });
});

function make(
  options: {
    store?: SearchIndexStore;
    yieldNow?: () => Promise<void>;
    maxStats?: number;
    onDamaged?: () => void;
  } = {},
): Scanner {
  scanner = createScanner({
    root,
    installedAt: 0,
    store: options.store ?? store,
    sessions: fakeScanPort().port,
    watch: watch.factory,
    clock,
    logger,
    onDamaged: options.onDamaged ?? (() => {}),
    yieldNow: options.yieldNow ?? nothing,
    process: (path) => {
      processed.push(path);
      return SKIPPED;
    },
    ...(options.maxStats === undefined ? {} : { maxStats: options.maxStats }),
  });
  return scanner;
}

function file(dir: string, name: string, text = "x\n"): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

/** A cursor that matches the file on disk now. */
function cursorOf(path: string, state: FileCursor["state"] = "indexed", shrink = 0): FileCursor {
  const stat = statSync(path);
  return {
    path,
    ino: stat.ino,
    size: stat.size - shrink,
    mtimeMs: stat.mtimeMs,
    offset: 0,
    skipLine: false,
    head: "h",
    state,
    sessionId: state === "excluded" ? null : "s",
    ownerId: state === "excluded" ? null : "u",
    indexedChars: 0,
  };
}

describe("scanner reconcile and lifecycle", () => {
  it("start lists what exists and processes each file once", async () => {
    const other = join(root, "--x--");
    mkdirSync(other);
    const paths = [file(folder, "a.jsonl"), file(folder, "b.jsonl"), file(other, "c.jsonl")];
    file(folder, "notes.txt");
    const s = make();
    s.start();
    await s.idle();
    expect([...processed].sort()).toEqual([...paths].sort());
    expect([...watch.open()].sort()).toEqual([root, folder, other].sort());
  });

  it("a new folder is listed by the reconcile it asks for", async () => {
    const old = file(folder, "old.jsonl");
    store.commit(cursorOf(old), []);
    const s = make();
    s.start();
    await s.idle();
    expect(processed).toEqual([]);
    const fresh = join(root, "--new--");
    mkdirSync(fresh);
    const path = file(fresh, "n.jsonl");
    watch.emit(root, "--new--");
    await clock.advance(1000);
    await s.idle();
    expect(processed).toEqual([path]);
    expect(watch.open()).toContain(fresh);
  });

  it("the reconcile finds what an event missed", async () => {
    const quiet = file(folder, "quiet.jsonl");
    const grown = file(folder, "grown.jsonl");
    store.commit(cursorOf(quiet), []);
    store.commit(cursorOf(grown), []);
    const s = make();
    s.start();
    await s.idle();
    expect(processed).toEqual([]);
    appendFileSync(grown, "more\n");
    await clock.advance(60_000);
    await s.idle();
    expect(processed).toEqual([grown]);
  });

  it("without sessions/ it waits, then lists the root once it appears", async () => {
    rmSync(root, { recursive: true });
    const s = make();
    s.start();
    await s.idle();
    expect(watch.open()).toEqual([agentDir]);
    mkdirSync(folder, { recursive: true });
    const path = file(folder, "a.jsonl");
    watch.emit(agentDir, "sessions");
    await clock.advance(1000);
    await s.idle();
    expect(processed).toEqual([path]);
    expect(watch.open()).toContain(root);
  });

  it("a watcher that failed is added back by the next reconcile", async () => {
    const s = make();
    s.start();
    await s.idle();
    watch.fail(folder, "ENOSPC");
    expect(watch.open()).not.toContain(folder);
    await clock.advance(60_000);
    await s.idle();
    expect(watch.open()).toContain(folder);
  });

  it("past 512 folders it still finds files by reconciling", async () => {
    const paths: string[] = [];
    for (let i = 0; i < 513; i += 1) {
      const dir = join(root, `--f${String(i).padStart(3, "0")}--`);
      mkdirSync(dir);
      paths.push(file(dir, "a.jsonl"));
    }
    const s = make();
    s.start();
    await s.idle();
    expect(watch.open()).toHaveLength(512);
    expect(processed.filter((path) => paths.includes(path))).toHaveLength(513);
    expect(processed).toContain(paths[512]);
  });

  it("a cursor whose file is gone is queued", async () => {
    const missing = join(folder, "gone.jsonl");
    store.commit({ ...cursorOf(file(folder, "tmp.jsonl")), path: missing }, []);
    const s = make();
    s.start();
    await s.idle();
    expect(processed).toContain(missing);
  });

  it("a symlinked folder is not followed", async () => {
    const outside = join(agentDir, "outside");
    mkdirSync(outside);
    file(outside, "o.jsonl");
    symlinkSync(outside, join(root, "--link--"));
    const s = make();
    s.start();
    await s.idle();
    expect(watch.open()).not.toContain(join(root, "--link--"));
    expect(processed.some((path) => path.includes("o.jsonl"))).toBe(false);
  });

  it("an excluded file is never compared, and at most maxStats files are compared per pass", async () => {
    const grown = ["a", "b", "c", "d", "e"].map((name) => file(folder, `${name}.jsonl`));
    for (const path of grown) store.commit(cursorOf(path, "indexed", 1), []);
    const excluded = file(folder, "x.jsonl");
    store.commit(cursorOf(excluded, "excluded", 1), []);
    const s = make({ maxStats: 2 });
    s.start();
    await s.idle();
    const first = processed.splice(0);
    await s.reconcile();
    await s.idle();
    const second = processed.splice(0);
    await s.reconcile();
    await s.idle();
    const third = processed.splice(0);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(new Set([...first, ...second]).size).toBe(4);
    // The third pass wraps around: its first file is one the first pass had, its other one the last file left.
    expect(third).toHaveLength(2);
    expect(third).toContain(first[0]);
    expect(new Set([...first, ...second, ...third])).toEqual(new Set(grown));
    expect([...first, ...second, ...third]).not.toContain(excluded);
  });

  it("a pass that throws is said once and the next one is still armed", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const paths = vi.fn((): string[] => {
        throw new Error("secret path /home/x");
      });
      const broken = { ...store, paths };
      const s = make({ store: broken });
      s.start();
      await s.idle();
      await clock.advance(0);
      const said = lines.filter((line) => line.msg === "session_list_failed");
      expect(said).toHaveLength(1);
      expect(JSON.stringify(said)).not.toContain("secret");
      expect(clock.pending()).toBe(1);
      // The timer's pass fails too, and the timer is armed again.
      await clock.advance(60_000);
      await s.idle();
      expect(paths).toHaveBeenCalledTimes(2);
      expect(clock.pending()).toBe(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("two reconciles at once run one pass", async () => {
    const paths = vi.fn(() => store.paths());
    const s = make({ store: { ...store, paths } });
    s.start();
    const first = s.reconcile();
    const second = s.reconcile();
    await Promise.all([first, second]);
    await s.idle();
    expect(paths).toHaveBeenCalledTimes(1);
  });

  it("stop during a slow pass: no store call after stop resolves", async () => {
    // 600 excluded files: nothing is queued, so only the listing yields (every 500 entries).
    for (let i = 0; i < 600; i += 1) {
      const path = file(folder, `f${String(i).padStart(3, "0")}.jsonl`);
      store.commit(cursorOf(path, "excluded"), []);
    }
    let release = (): void => undefined;
    const held = new Promise<void>((done) => {
      release = done;
    });
    let yields = 0;
    let stopped = false;
    const late: string[] = [];
    const spied = Object.fromEntries(
      (Object.keys(store) as Array<keyof SearchIndexStore>).map((name) => [
        name,
        (...args: unknown[]) => {
          if (stopped) late.push(name);
          return (store[name] as (...a: unknown[]) => unknown)(...args);
        },
      ]),
    ) as unknown as SearchIndexStore;
    const s = make({
      store: spied,
      yieldNow: () => {
        yields += 1;
        return yields === 1 ? held : Promise.resolve();
      },
    });
    s.start();
    const pass = s.reconcile();
    let passSettled = false;
    void pass.then(() => {
      passSettled = true;
    });
    await vi.waitFor(() => expect(yields).toBe(1), { timeout: 5000 });
    let stopSettled = false;
    const stopping = s.stop().then(() => {
      stopped = true;
      stopSettled = true;
    });
    // The pass is held inside its listing: stop waits for it.
    await clock.advance(0);
    expect(stopSettled).toBe(false);
    release();
    await stopping;
    expect(passSettled).toBe(true);
    await clock.advance(100);
    expect(late).toEqual([]);
    expect(clock.pending()).toBe(0);
    expect(watch.open()).toEqual([]);
  });
});
