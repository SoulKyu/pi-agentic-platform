import { Worker } from "node:worker_threads";
import { PapError } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { QueryInput, QueryRow } from "./query.ts";

export const QUERY_TIMEOUT_MS = 2_000;
export const MAX_IN_FLIGHT = 4;
export const IDLE_STOP_MS = 5 * 60_000;
export const MAX_SPAWNS_PER_MINUTE = 3;
export const STOP_TIMEOUT_MS = 2_000;
/** The thread aborts its own statement a little before the client gives up, so a slow query keeps the thread. */
export const THREAD_BUDGET_MS = QUERY_TIMEOUT_MS - 250;

export interface ThreadLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
  unref(): void;
}
export type SpawnThread = (dbPath: string) => ThreadLike;

/** The thread file next to this module: TypeScript in the sources, JavaScript in the build (M4R53). */
export const threadEntry = (moduleUrl: string): URL =>
  new URL(moduleUrl.endsWith(".ts") ? "./search-thread.ts" : "./search-thread.js", moduleUrl);

const spawnSearchThread: SpawnThread = (dbPath) =>
  new Worker(threadEntry(import.meta.url), {
    workerData: { path: dbPath },
    execArgv: ["--disable-warning=ExperimentalWarning"],
    resourceLimits: { maxOldGenerationSizeMb: 64 },
  });

export interface SearchClient {
  query(input: QueryInput): Promise<QueryRow[]>;
  stop(): Promise<void>;
}

interface Pending {
  resolve(rows: QueryRow[]): void;
  reject(error: PapError): void;
  readonly timer: TimerHandle;
}

type Answer = { id: number; ok: true; rows: QueryRow[] } | { id: number; ok: false; code: string };
const answerOf = (message: unknown): Answer | null => {
  const value = message as { id?: unknown; ok?: unknown; rows?: unknown; code?: unknown } | null;
  if (typeof value?.id !== "number") return null;
  if (value.ok === true && Array.isArray(value.rows))
    return { id: value.id, ok: true, rows: value.rows as QueryRow[] };
  if (value.ok === false) return { id: value.id, ok: false, code: String(value.code).slice(0, 64) };
  return null;
};

export function createSearchClient(deps: {
  readonly dbPath: string;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly spawn?: SpawnThread;
  /** The thread met a damaged index: the module rebuilds it (M4R127). */
  readonly onDamaged?: () => void;
}): SearchClient {
  const spawn = deps.spawn ?? spawnSearchThread;
  const pending = new Map<number, Pending>();
  const spawns: number[] = [];
  let thread: ThreadLike | null = null;
  let idle: TimerHandle | null = null;
  let nextId = 1;
  let stopped = false;
  let saidRestarts = false;
  let saidSpawnFailed = false;

  const clearIdle = () => {
    if (idle) deps.clock.clearTimeout(idle);
    idle = null;
  };
  const rejectAll = (code: "timeout" | "internal") => {
    for (const entry of pending.values()) {
      deps.clock.clearTimeout(entry.timer);
      entry.reject(new PapError(code));
    }
    pending.clear();
  };
  const drop = () => {
    const current = thread;
    thread = null;
    clearIdle();
    if (current)
      current
        .terminate()
        .catch((error: unknown) => deps.logger.debug("search_thread_terminate_failed", { err: error }));
  };
  const armIdle = () => {
    clearIdle();
    if (!thread || pending.size > 0) return;
    idle = deps.clock.setTimeout(() => {
      idle = null;
      if (pending.size === 0) drop();
    }, IDLE_STOP_MS);
  };
  const ensure = (): ThreadLike => {
    if (thread) return thread;
    const now = deps.clock.now();
    while (spawns.length > 0 && now - (spawns[0] ?? 0) >= 60_000) spawns.shift();
    if (spawns.length >= MAX_SPAWNS_PER_MINUTE) {
      if (!saidRestarts) deps.logger.warn("search_thread_restarts", { max: MAX_SPAWNS_PER_MINUTE });
      saidRestarts = true;
      throw new PapError("internal");
    }
    saidRestarts = false;
    const created = spawn(deps.dbPath);
    saidSpawnFailed = false;
    spawns.push(now);
    created.unref();
    // Events of a thread that was replaced since are ignored: only the current one settles queries.
    created.on("message", (message) => {
      if (created !== thread) return;
      const answer = answerOf(message);
      const entry = answer ? pending.get(answer.id) : undefined;
      if (!answer || !entry) return;
      pending.delete(answer.id);
      deps.clock.clearTimeout(entry.timer);
      if (answer.ok) entry.resolve(answer.rows);
      else if (answer.code === "timeout") {
        // The thread aborted the statement itself and is healthy.
        deps.logger.warn("search_query_timeout", { ms: QUERY_TIMEOUT_MS });
        entry.reject(new PapError("timeout"));
      } else {
        deps.logger.warn("search_query_failed", { code: answer.code });
        if (answer.code === "damaged") deps.onDamaged?.();
        entry.reject(new PapError("internal"));
      }
      armIdle();
    });
    const gone = (kind: string, code: string) => {
      if (created !== thread) return;
      thread = null;
      clearIdle();
      deps.logger.warn("search_thread_failed", { kind, code });
      rejectAll("internal");
    };
    created.on("error", (error) =>
      gone(
        "error",
        String(
          (error as { code?: unknown } | null)?.code ?? (error as { name?: unknown } | null)?.name,
        ).slice(0, 64),
      ),
    );
    created.on("exit", (code) => gone("exit", String(code)));
    thread = created;
    return created;
  };

  return {
    query(input) {
      if (stopped) return Promise.reject(new PapError("internal"));
      if (pending.size >= MAX_IN_FLIGHT) return Promise.reject(new PapError("capacity"));
      let current: ThreadLike;
      try {
        current = ensure();
      } catch (error) {
        if (!(error instanceof PapError) && !saidSpawnFailed)
          deps.logger.warn("search_thread_spawn_failed", { err: error });
        if (!(error instanceof PapError)) saidSpawnFailed = true;
        return Promise.reject(error instanceof PapError ? error : new PapError("internal"));
      }
      clearIdle();
      const id = nextId++;
      return new Promise<QueryRow[]>((resolve, reject) => {
        const timer = deps.clock.setTimeout(() => {
          // The thread may be stuck inside this query (terminate() does not interrupt SQLite; the thread's own deadline
          // aborts it between rows): the thread is abandoned, and what waits behind it times out too (M4R50).
          pending.delete(id);
          deps.logger.warn("search_query_timeout", { ms: QUERY_TIMEOUT_MS });
          rejectAll("timeout");
          drop();
          reject(new PapError("timeout"));
        }, QUERY_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        try {
          // Absolute, from the moment of asking: a query queued behind a slow one must not get a fresh budget.
          current.postMessage({ id, input, deadlineAt: deps.clock.now() + THREAD_BUDGET_MS });
        } catch (error) {
          pending.delete(id);
          deps.clock.clearTimeout(timer);
          deps.logger.warn("search_thread_post_failed", { err: error });
          reject(new PapError("internal"));
          armIdle();
        }
      });
    },
    async stop() {
      stopped = true;
      clearIdle();
      rejectAll("internal");
      const current = thread;
      thread = null;
      if (!current) return;
      // terminate() waits for the thread, which may sit inside SQLite: stop() waits a bounded time, then moves on.
      const slow: { handle: TimerHandle | null } = { handle: null };
      const bound = new Promise<void>((resolve) => {
        slow.handle = deps.clock.setTimeout(() => {
          deps.logger.warn("search_thread_stop_slow", { ms: STOP_TIMEOUT_MS });
          resolve();
        }, STOP_TIMEOUT_MS);
      });
      const done = current
        .terminate()
        .then(() => undefined)
        .catch((error: unknown) => deps.logger.debug("search_thread_terminate_failed", { err: error }));
      await Promise.race([done, bound]);
      if (slow.handle) deps.clock.clearTimeout(slow.handle);
    },
  };
}
