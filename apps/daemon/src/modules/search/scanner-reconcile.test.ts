import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../kernel/db/database.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { openSearchIndex } from "./index-db.ts";
import { createSearchIndexStore, type FileCursor, type SearchIndexStore } from "./index-store.ts";
import { type ReconcileState, reconcilePass } from "./scanner-reconcile.ts";

let dir = "";
let root = "";
let folder = "";
let db: Db;
let store: SearchIndexStore;
let state: ReconcileState;
let stopped: boolean;
const engine = {
  watchRoot: vi.fn<() => void>(),
  watchFolder: vi.fn<(dir: string) => void>(),
  unwatch: vi.fn<(dir: string) => void>(),
  enqueue: vi.fn<(path: string) => void>(),
};
const say = vi.fn<(event: string, fields?: Record<string, unknown>) => void>();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-reconcile-"));
  root = join(dir, "sessions");
  folder = join(root, "--w--");
  mkdirSync(folder, { recursive: true });
  db = openSearchIndex(join(dir, "search.db"), silentLogger);
  store = createSearchIndexStore(db);
  state = { at: 0, folders: new Set() };
  stopped = false;
  for (const mock of [...Object.values(engine), say]) mock.mockReset();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const pass = (
  options: { yieldNow?: () => Promise<void>; store?: SearchIndexStore; maxStats?: number } = {},
): Promise<void> =>
  reconcilePass({
    root,
    store: options.store ?? store,
    engine,
    yieldNow: options.yieldNow ?? (() => Promise.resolve()),
    stopped: () => stopped,
    say,
    state,
    ...(options.maxStats === undefined ? {} : { maxStats: options.maxStats }),
  });

function indexedCursor(path: string, shrink = 0): FileCursor {
  const stat = statSync(path);
  return {
    path,
    ino: stat.ino,
    size: stat.size - shrink,
    mtimeMs: stat.mtimeMs,
    offset: 0,
    skipLine: false,
    head: "h",
    state: "indexed",
    sessionId: "s",
    ownerId: "u",
    indexedChars: 0,
  };
}

function files(count: number, text = "x\n"): string[] {
  return Array.from({ length: count }, (_, i) => {
    const path = join(folder, `f${String(i).padStart(3, "0")}.jsonl`);
    writeFileSync(path, text);
    return path;
  });
}

function hold(): { release(): void; held: Promise<void> } {
  let release = (): void => undefined;
  const held = new Promise<void>((done) => {
    release = done;
  });
  return { release, held };
}

describe("reconcile pass stops where it is told to (M4R74)", () => {
  it("stopped during the listing's yield: no file after it is queued", async () => {
    files(600);
    const gate = hold();
    let yields = 0;
    const running = pass({
      yieldNow: () => {
        yields += 1;
        return gate.held;
      },
    });
    await vi.waitFor(() => expect(yields).toBe(1), { timeout: 5000 });
    stopped = true;
    gate.release();
    await running;
    // The yield comes at the 500th entry, before it is looked at.
    expect(engine.enqueue).toHaveBeenCalledTimes(499);
  });

  it("stopped during the comparison's yield: no further file is compared", async () => {
    for (const path of files(600)) store.commit(indexedCursor(path, 1), []);
    const gate = hold();
    let yields = 0;
    const paths = vi.fn(() => store.paths());
    const running = pass({
      store: { ...store, paths },
      yieldNow: () => {
        yields += 1;
        return yields === 2 ? gate.held : Promise.resolve();
      },
    });
    await vi.waitFor(() => expect(yields).toBe(2), { timeout: 5000 });
    stopped = true;
    gate.release();
    await running;
    expect(engine.enqueue).toHaveBeenCalledTimes(500);
    expect(paths).not.toHaveBeenCalled();
  });

  it("stopped by the last comparison: the gone pass does not read the store", async () => {
    const grown = files(3);
    for (const path of grown) store.commit(indexedCursor(path, 1), []);
    engine.enqueue.mockImplementation(() => {
      if (engine.enqueue.mock.calls.length === 3) stopped = true;
    });
    const paths = vi.fn(() => store.paths());
    await pass({ store: { ...store, paths } });
    expect(engine.enqueue).toHaveBeenCalledTimes(3);
    expect(paths).not.toHaveBeenCalled();
  });
});

describe("reconcile pass and what is gone", () => {
  it("without sessions/ the cursors of vanished files are still queued (M4R72)", async () => {
    const [path] = files(1);
    store.commit(indexedCursor(path as string), []);
    rmSync(root, { recursive: true });
    await pass();
    expect(engine.enqueue).toHaveBeenCalledWith(path);
    expect(engine.watchRoot).toHaveBeenCalled();
  });

  it.skipIf(process.getuid?.() === 0)(
    "a folder that cannot be listed is not gone: kept, its files not queued as gone",
    async () => {
      const [path] = files(1);
      store.commit(indexedCursor(path as string), []);
      chmodSync(folder, 0o000);
      try {
        await pass();
        expect(say).toHaveBeenCalledWith("session_list_failed", { code: "EACCES" });
        expect(engine.enqueue).not.toHaveBeenCalled();
        expect(state.folders.has(folder)).toBe(true);
        await pass();
        expect(engine.unwatch).not.toHaveBeenCalled();
        expect(engine.enqueue).not.toHaveBeenCalled();
      } finally {
        chmodSync(folder, 0o700);
      }
    },
  );

  it("a folder that vanished is unwatched once and not said", async () => {
    files(1);
    await pass();
    rmSync(folder, { recursive: true });
    await pass();
    expect(engine.unwatch).toHaveBeenCalledWith(folder);
    expect(say).not.toHaveBeenCalled();
  });

  it("judges only the files under its own root: another root's cursors are left alone", async () => {
    const other = join(dir, "other", "box");
    mkdirSync(other, { recursive: true });
    const foreign = join(other, "f.jsonl");
    writeFileSync(foreign, "x\n");
    store.commit(indexedCursor(foreign, 1), []);
    files(1);
    await pass();
    expect(engine.enqueue).not.toHaveBeenCalledWith(foreign);
    rmSync(root, { recursive: true });
    await pass();
    expect(engine.enqueue).not.toHaveBeenCalledWith(foreign);
  });

  it("does not list a mirror's replaced/ subfolder", async () => {
    mkdirSync(join(folder, "replaced"));
    writeFileSync(join(folder, "replaced", "old.jsonl"), "x\n");
    const [live] = files(1);
    await pass();
    expect(engine.enqueue.mock.calls.map(([path]) => path)).toEqual([live]);
  });
});
