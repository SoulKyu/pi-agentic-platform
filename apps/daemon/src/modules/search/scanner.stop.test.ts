import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import { openSearchIndex } from "./index-db.ts";
import { createSearchIndexStore, type SearchIndexStore } from "./index-store.ts";
import { createScanner, STOP_WAIT_MS } from "./scanner.ts";
import { fakeScanPort } from "./testing/fake-scan-port.ts";
import { fakeWatch } from "./testing/fake-watch.ts";

let dir = "";
let folder = "";
let clock: FakeClock;
let db: Db;
let dbOpen = false;
let lines: string[];

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (msg) => {
    lines.push(msg);
  },
  error: (msg) => {
    lines.push(msg);
  },
  child: () => logger,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-scanner-stop-"));
  folder = join(dir, "sessions", "--w--");
  mkdirSync(folder, { recursive: true });
  clock = createFakeClock();
  db = openSearchIndex(join(dir, "search.db"), logger);
  dbOpen = true;
  lines = [];
});
afterEach(() => {
  if (dbOpen) db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Every store method records its call once `armed` is true. */
function spyStore(store: SearchIndexStore, calls: string[], armed: () => boolean): SearchIndexStore {
  return Object.fromEntries(
    (Object.keys(store) as Array<keyof SearchIndexStore>).map((name) => [
      name,
      (...args: unknown[]) => {
        if (armed()) calls.push(name);
        return (store[name] as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  ) as unknown as SearchIndexStore;
}

describe("scanner stop", () => {
  it("a pass stuck in its listing is given up on after STOP_WAIT_MS, and does nothing when it wakes", async () => {
    const real = createSearchIndexStore(db);
    for (let i = 0; i < 600; i += 1) {
      const path = join(folder, `f${String(i).padStart(3, "0")}.jsonl`);
      writeFileSync(path, "x\n");
      const stat = statSync(path);
      real.commit(
        {
          path,
          ino: stat.ino,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          offset: 0,
          skipLine: false,
          head: "h",
          state: "excluded",
          sessionId: null,
          ownerId: null,
          indexedChars: 0,
        },
        [],
      );
    }
    let release = (): void => undefined;
    const held = new Promise<void>((done) => {
      release = done;
    });
    let yields = 0;
    let armed = false;
    const calls: string[] = [];
    const watch = fakeWatch();
    const scanner = createScanner({
      root: join(dir, "sessions"),
      installedAt: 0,
      store: spyStore(real, calls, () => armed),
      sessions: fakeScanPort().port,
      watch: watch.factory,
      clock,
      logger,
      onDamaged: () => {},
      yieldNow: () => {
        yields += 1;
        return yields === 1 ? held : Promise.resolve();
      },
    });
    scanner.start();
    await vi.waitFor(() => expect(yields).toBe(1), { timeout: 5000 });
    let stopSettled = false;
    void scanner.stop().then(() => {
      stopSettled = true;
    });
    await clock.advance(STOP_WAIT_MS - 1);
    expect(stopSettled).toBe(false);
    await clock.advance(1);
    expect(stopSettled).toBe(true);
    expect(lines.filter((line) => line === "session_scanner_stop_slow")).toHaveLength(1);
    expect(clock.pending()).toBe(0);
    // The daemon closes the database; the pass wakes up afterwards.
    db.close();
    dbOpen = false;
    armed = true;
    release();
    await clock.advance(100);
    expect(calls).toEqual([]);
    expect(lines).not.toContain("session_list_failed");
    expect(watch.open()).toEqual([]);
  });

  it("a stopped scanner cannot be started again", async () => {
    const calls: string[] = [];
    const watch = fakeWatch();
    const scanner = createScanner({
      root: join(dir, "sessions"),
      installedAt: 0,
      store: spyStore(createSearchIndexStore(db), calls, () => true),
      sessions: fakeScanPort().port,
      watch: watch.factory,
      clock,
      logger,
      onDamaged: () => {},
      yieldNow: () => Promise.resolve(),
    });
    scanner.start();
    await scanner.idle();
    await scanner.stop();
    const watched = watch.watched.length;
    calls.length = 0;
    scanner.start();
    await clock.advance(60_000);
    await scanner.idle();
    expect(watch.watched).toHaveLength(watched);
    expect(calls).toEqual([]);
    expect(clock.pending()).toBe(0);
  });
});
