import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { openSearchIndex } from "./index-db.ts";
import { createSearchIndexStore } from "./index-store.ts";
import { createSearchClient, type SpawnThread, threadEntry } from "./search-client.ts";

describe("search client with a real worker thread", () => {
  let dir: string;
  let db: Db;
  let workers: Worker[];
  let exited: Promise<void>[];

  const spawn: SpawnThread = (dbPath) => {
    const worker = new Worker(threadEntry(new URL("./search-client.ts", import.meta.url).href), {
      workerData: { path: dbPath },
      execArgv: ["--disable-warning=ExperimentalWarning"],
    });
    workers.push(worker);
    exited.push(new Promise<void>((resolve) => worker.once("exit", () => resolve())));
    return worker;
  };
  const clientOf = () =>
    createSearchClient({
      dbPath: join(dir, "search.db"),
      clock: createSystemClock(),
      logger: silentLogger,
      spawn,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pap-search-client-"));
    workers = [];
    exited = [];
    db = openSearchIndex(join(dir, "search.db"), silentLogger);
    createSearchIndexStore(db).commit(
      {
        path: "/s/a.jsonl",
        ino: 1,
        size: 10,
        mtimeMs: 1,
        offset: 10,
        skipLine: false,
        head: "{}",
        state: "indexed",
        sessionId: "s1",
        ownerId: "u1",
        indexedChars: 0,
      },
      [{ entryId: "e1", role: "user", at: 1, text: "deploy the kubernetes cluster" }],
    );
  });

  afterEach(async () => {
    await Promise.all(workers.map((worker) => worker.terminate()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds a committed row, works again for a second client after stop(), and the worker exits on stop()", async () => {
    const first = clientOf();
    const rows = await first.query({ match: '"kubernetes"', ownerId: "u1", limit: 20 });
    expect(rows.map((row) => [row.sessionId, row.entryId])).toEqual([["s1", "e1"]]);
    await first.stop();
    await exited[0];
    const second = clientOf();
    expect(await second.query({ match: '"cluster"', ownerId: "u1", limit: 20 })).toHaveLength(1);
    expect(await second.query({ match: '"cluster"', ownerId: "u2", limit: 20 })).toEqual([]);
    await second.stop();
    await exited[1];
  });

  it("the thread answers `timeout` for a query whose deadline passed while it waited in the queue", async () => {
    const worker = spawn(join(dir, "search.db")) as Worker;
    const answer = new Promise<unknown>((resolve) => worker.once("message", resolve));
    worker.postMessage({
      id: 1,
      input: { match: '"kubernetes"', ownerId: "u1", limit: 20 },
      deadlineAt: Date.now() - 1,
    });
    expect(await answer).toEqual({ id: 1, ok: false, code: "timeout" });
  });
});
