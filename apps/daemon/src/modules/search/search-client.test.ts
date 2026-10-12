import { PapError } from "@pap/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { createLogger } from "../../kernel/logger.ts";
import {
  createSearchClient,
  IDLE_STOP_MS,
  MAX_IN_FLIGHT,
  MAX_SPAWNS_PER_MINUTE,
  QUERY_TIMEOUT_MS,
  type SearchClient,
  threadEntry,
  type ThreadLike,
} from "./search-client.ts";

class FakeThread implements ThreadLike {
  posted: Array<{ id: number; input: unknown }> = [];
  terminated = 0;
  unrefs = 0;
  throwOnPost = false;
  private listeners: Record<string, Array<(value: never) => void>> = {};
  postMessage(message: unknown): void {
    if (this.throwOnPost) throw new Error("boom");
    this.posted.push(message as { id: number; input: unknown });
  }
  on(event: string, listener: (value: never) => void): this {
    (this.listeners[event] ??= []).push(listener);
    return this;
  }
  terminate(): Promise<number> {
    this.terminated++;
    return Promise.resolve(1);
  }
  unref(): void {
    this.unrefs++;
  }
  emit(event: string, value?: unknown): void {
    for (const listener of this.listeners[event] ?? []) listener(value as never);
  }
  answer(id: number, rows: unknown[] = []): void {
    this.emit("message", { id, ok: true, rows });
  }
}

const INPUT = { match: '"a"', ownerId: "u1", limit: 20 };
const ROW = { sessionId: "s1", entryId: "e1", role: "user", at: 1, snippet: "x" };
const settle = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => "ok",
    (error: unknown) => (error instanceof PapError ? error.code : "other"),
  );

describe("search client", () => {
  let clock: FakeClock;
  let threads: FakeThread[];
  let lines: Array<Record<string, unknown>>;
  let damaged: number;
  let client: SearchClient;

  beforeEach(() => {
    clock = createFakeClock();
    threads = [];
    lines = [];
    damaged = 0;
    client = createSearchClient({
      dbPath: "/x/search.db",
      clock,
      logger: createLogger({
        level: "debug",
        clock: createFakeClock(),
        write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
      }),
      spawn: () => {
        const thread = new FakeThread();
        threads.push(thread);
        return thread;
      },
      onDamaged: () => void damaged++,
    });
  });

  it("starts the thread on the first query only, and two queries share it", async () => {
    expect(threads).toHaveLength(0);
    const a = client.query(INPUT);
    const b = client.query(INPUT);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.unrefs).toBe(1);
    expect(threads[0]?.posted.map((m) => m.id)).toEqual([1, 2]);
    threads[0]?.answer(1, [ROW]);
    threads[0]?.answer(2);
    expect(await a).toEqual([ROW]);
    expect(await b).toEqual([]);
  });

  it("ignores an answer for an unknown id (late, after a timeout)", async () => {
    const first = settle(client.query(INPUT));
    const old = threads[0];
    await clock.advance(QUERY_TIMEOUT_MS);
    expect(await first).toBe("timeout");
    const second = client.query(INPUT);
    expect(threads).toHaveLength(2);
    old?.answer(2, [ROW]);
    threads[1]?.answer(2, []);
    expect(await second).toEqual([]);
  });

  it("rejects `capacity` for the query past the in-flight cap, without posting", async () => {
    const running = Array.from({ length: MAX_IN_FLIGHT }, () => client.query(INPUT));
    expect(await settle(client.query(INPUT))).toBe("capacity");
    expect(threads[0]?.posted).toHaveLength(MAX_IN_FLIGHT);
    threads[0]?.emit("exit", 1);
    await Promise.all(running.map(settle));
  });

  it("times out after 2 s, terminates the thread, times out the queue behind, and spawns anew", async () => {
    const first = settle(client.query(INPUT));
    await clock.advance(1_000);
    const second = settle(client.query(INPUT));
    expect(QUERY_TIMEOUT_MS).toBe(2_000);
    await clock.advance(999);
    expect(threads[0]?.terminated).toBe(0);
    await clock.advance(1);
    expect(await first).toBe("timeout");
    expect(await second).toBe("timeout");
    expect(threads[0]?.terminated).toBe(1);
    expect(clock.pending()).toBe(0);
    const third = client.query(INPUT);
    expect(threads).toHaveLength(2);
    threads[1]?.answer(3);
    expect(await third).toEqual([]);
  });

  it("a thread that exits rejects pending queries `internal`, and the next query spawns again", async () => {
    const pending = client.query(INPUT);
    threads[0]?.emit("exit", 1);
    expect(await settle(pending)).toBe("internal");
    expect(clock.pending()).toBe(0);
    void settle(client.query(INPUT));
    expect(threads).toHaveLength(2);
  });

  it("a thread error rejects pending queries `internal`", async () => {
    const pending = client.query(INPUT);
    threads[0]?.emit("error", new Error("x"));
    expect(await settle(pending)).toBe("internal");
  });

  it("events of a replaced thread are ignored", async () => {
    const first = settle(client.query(INPUT));
    const old = threads[0];
    await clock.advance(QUERY_TIMEOUT_MS);
    await first;
    const second = client.query(INPUT);
    old?.emit("exit", 1);
    threads[1]?.answer(2);
    expect(await second).toEqual([]);
  });

  it("refuses a 4th spawn within a minute with `internal`, logs once, and spawns a minute later", async () => {
    for (let i = 0; i < MAX_SPAWNS_PER_MINUTE; i++) {
      const pending = client.query(INPUT);
      threads[i]?.emit("exit", 1);
      await settle(pending);
    }
    expect(threads).toHaveLength(3);
    expect(await settle(client.query(INPUT))).toBe("internal");
    expect(await settle(client.query(INPUT))).toBe("internal");
    expect(threads).toHaveLength(3);
    expect(lines.filter((line) => line["msg"] === "search_thread_restarts")).toHaveLength(1);
    await clock.advance(60_000);
    void settle(client.query(INPUT));
    expect(threads).toHaveLength(4);
  });

  it("terminates the thread after 5 idle minutes, and a query in between keeps it", async () => {
    const first = client.query(INPUT);
    threads[0]?.answer(1);
    await first;
    await clock.advance(IDLE_STOP_MS - 1);
    expect(threads[0]?.terminated).toBe(0);
    const second = client.query(INPUT);
    threads[0]?.answer(2);
    await second;
    await clock.advance(IDLE_STOP_MS - 1);
    expect(threads[0]?.terminated).toBe(0);
    await clock.advance(1);
    expect(threads[0]?.terminated).toBe(1);
    void settle(client.query(INPUT));
    expect(threads).toHaveLength(2);
  });

  it("stop() rejects pending queries, terminates the thread, clears timers, and refuses later queries", async () => {
    const pending = client.query(INPUT);
    await client.stop();
    expect(await settle(pending)).toBe("internal");
    expect(threads[0]?.terminated).toBe(1);
    expect(clock.pending()).toBe(0);
    expect(await settle(client.query(INPUT))).toBe("internal");
    expect(threads).toHaveLength(1);
  });

  it("stop() settles even when terminate() rejects", async () => {
    void settle(client.query(INPUT));
    const thread = threads[0];
    if (thread) thread.terminate = () => Promise.reject(new Error("gone"));
    await expect(client.stop()).resolves.toBeUndefined();
  });

  it("a postMessage that throws rejects that query `internal` and logs search_thread_post_failed", async () => {
    void settle(client.query(INPUT));
    const thread = threads[0];
    if (thread) thread.throwOnPost = true;
    expect(await settle(client.query(INPUT))).toBe("internal");
    expect(lines.filter((line) => line["msg"] === "search_thread_post_failed")).toHaveLength(1);
    expect(clock.pending()).toBe(1);
  });

  it("a `damaged` answer rejects `internal` and calls onDamaged once; `query_failed` does not", async () => {
    const a = client.query(INPUT);
    threads[0]?.emit("message", { id: 1, ok: false, code: "query_failed" });
    expect(await settle(a)).toBe("internal");
    expect(damaged).toBe(0);
    const b = client.query(INPUT);
    threads[0]?.emit("message", { id: 2, ok: false, code: "damaged" });
    expect(await settle(b)).toBe("internal");
    expect(damaged).toBe(1);
  });

  it("drops malformed answers", async () => {
    const a = client.query(INPUT);
    threads[0]?.emit("message", { id: 1, ok: true, rows: "no" });
    threads[0]?.emit("message", null);
    threads[0]?.answer(1, [ROW]);
    expect(await a).toEqual([ROW]);
  });

  it("threadEntry picks .ts next to a .ts module and .js next to a .js one", () => {
    expect(threadEntry("file:///m/search-client.ts").pathname).toMatch(/\/m\/search-thread\.ts$/);
    expect(threadEntry("file:///m/search-client.js").pathname).toMatch(/\/m\/search-thread\.js$/);
  });
});
