import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { type QueryInput, QueryDeadlineError, runQuery } from "./query.ts";
import { isDamagedCode } from "./sqlite-codes.ts";

// A worker thread of the search module (ADR 0013): one read-only connection, one query at a time.
const port = parentPort;
if (!port) throw new Error("search-thread runs as a worker thread");
const db = new DatabaseSync(String((workerData as { path?: unknown }).path), { readOnly: true });
db.exec("PRAGMA busy_timeout = 1000");

port.on("message", (message: { id: number; input: QueryInput; deadlineAt: number }) => {
  try {
    port.postMessage({
      id: message.id,
      ok: true,
      rows: runQuery(db, message.input, { at: message.deadlineAt }),
    });
  } catch (error) {
    if (error instanceof QueryDeadlineError) {
      port.postMessage({ id: message.id, ok: false, code: "timeout" });
      return;
    }
    // A code, never SQLite's text: the main thread logs it and answers `internal`; damage asks for a rebuild (M4R127).
    const damaged = isDamagedCode((error as { errcode?: unknown } | null)?.errcode);
    port.postMessage({ id: message.id, ok: false, code: damaged ? "damaged" : "query_failed" });
  }
});
