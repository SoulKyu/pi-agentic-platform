import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { openDatabase } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
const opens = vi.hoisted(() => ({ fail: false }));
vi.mock("./index-db.ts", async (original) => {
  const real = await original<typeof import("./index-db.ts")>();
  return {
    ...real,
    openSearchIndex: (...args: Parameters<typeof real.openSearchIndex>) => {
      if (opens.fail) throw new Error("cannot open");
      return real.openSearchIndex(...args);
    },
  };
});
const { createSearchModule } = await import("./index.ts");
import type { SearchModule } from "./index.ts";
import type { ThreadLike } from "./search-client.ts";
import { type FakeWatch, fakeWatch } from "./testing/fake-watch.ts";

/** A thread that answers every query with the same code. */
class DamagedThread implements ThreadLike {
  private listeners: Array<(message: unknown) => void> = [];
  postMessage(message: unknown): void {
    const { id } = message as { id: number };
    queueMicrotask(() => {
      for (const listener of this.listeners) listener({ id, ok: false, code: "damaged" });
    });
  }
  on(event: string, listener: (value: never) => void): this {
    if (event === "message") this.listeners.push(listener as (message: unknown) => void);
    return this;
  }
  terminate = (): Promise<number> => Promise.resolve(1);
  unref = (): void => {};
}

const sessions = {
  claim: () => ({ kind: "wait" as const }),
  touched: () => {},
  named: () => {},
  previewed: () => {},
  summary: () => null,
};
const ctx = {
  caller: testCaller(),
  connectionId: "c",
  openSubscription: vi.fn(),
  closeSubscription: vi.fn(),
};

describe("search module rebuild", () => {
  let home: string;
  let agentDir: string;
  let root: string;
  let clock: FakeClock;
  let watch: FakeWatch;
  let lines: Array<{ msg: string; fields?: unknown }>;
  let module: SearchModule | undefined;
  let logger: Logger;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pap-rebuild-home-"));
    agentDir = mkdtempSync(join(tmpdir(), "pap-rebuild-agent-"));
    root = join(agentDir, "sessions");
    mkdirSync(join(root, "--w--"), { recursive: true });
    clock = createFakeClock();
    watch = fakeWatch();
    lines = [];
    opens.fail = false;
    const push = (msg: string, fields?: Record<string, unknown>) => lines.push({ msg, fields });
    logger = { debug: () => {}, info: push, warn: push, error: push, child: () => logger };
  });
  afterEach(async () => {
    await module?.stop();
    module = undefined;
    rmSync(home, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  const count = (msg: string) => lines.filter((line) => line.msg === msg).length;
  const make = (extra: Partial<Parameters<typeof createSearchModule>[0]> = {}): SearchModule => {
    module = createSearchModule({
      home,
      agentDir,
      installedAt: 0,
      readOnly: false,
      clock,
      logger,
      sessions,
      watch: watch.factory,
      yieldNow: () => Promise.resolve(),
      ...extra,
    });
    return module;
  };
  const query = () => module?.rpc["search.query"]({ q: "kube" }, ctx) as Promise<unknown>;
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => "ok",
      (error: unknown) => (error instanceof PapError ? error.code : "other"),
    );

  it("a damaged index met by the scanner is rebuilt once", async () => {
    writeFileSync(join(root, "--w--", "a.jsonl"), "x\n");
    let calls = 0;
    const m = make({
      process: () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("malformed"), { errcode: 11 });
        return { kind: "gone" };
      },
    });
    m.start();
    await vi.waitFor(() => expect(count("search_index_rebuilt")).toBe(1), { timeout: 5000 });
    await vi.waitFor(() => expect(calls).toBe(2), { timeout: 5000 });
    expect(lines.find((line) => line.msg === "search_index_rebuilt")?.fields).toEqual({ reason: "damaged" });
    expect(existsSync(join(home, "search.db"))).toBe(true);
    const check = openDatabase(join(home, "search.db"), { readOnly: true });
    try {
      expect(check.get("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: "1" });
    } finally {
      check.close();
    }
    expect(watch.open()).toContain(root);
    expect(watch.watched.filter((dir) => dir === root)).toHaveLength(2);
  });

  it("a damaged index met by a query is rebuilt", async () => {
    const m = make({ spawn: () => new DamagedThread() });
    m.start();
    await expect(code(query())).resolves.toBe("internal");
    await vi.waitFor(() => expect(count("search_index_rebuilt")).toBe(1), { timeout: 5000 });
    expect(watch.open()).toContain(root);
  });

  it("past 3 rebuilds in an hour, search is off until the next start", async () => {
    const m = make({ spawn: () => new DamagedThread() });
    m.start();
    for (let i = 1; i <= 3; i += 1) {
      await expect(code(query())).resolves.toBe("internal");
      await vi.waitFor(() => expect(count("search_index_rebuilt")).toBe(i), { timeout: 5000 });
    }
    await expect(code(query())).resolves.toBe("internal");
    await vi.waitFor(() => expect(count("search_index_unusable")).toBe(1), { timeout: 5000 });
    await expect(code(query())).resolves.toBe("internal");
    expect(count("search_index_rebuilt")).toBe(3);
    expect(count("search_index_unusable")).toBe(1);
    expect(watch.open()).toEqual([]);
  });

  it("in read-only mode the scanner does not start", async () => {
    const m = make({ readOnly: true });
    m.start();
    await expect(m.rpc["search.query"]({ q: "kube" }, ctx)).resolves.toEqual({ hits: [] });
    expect(watch.watched).toEqual([]);
    expect(existsSync(join(home, "search.db"))).toBe(false);
    expect(count("search_disabled_read_only")).toBe(1);
  });

  it("a 4th rebuild is allowed once an hour has passed", async () => {
    const m = make({ spawn: () => new DamagedThread() });
    m.start();
    for (let i = 1; i <= 3; i += 1) {
      await expect(code(query())).resolves.toBe("internal");
      await vi.waitFor(() => expect(count("search_index_rebuilt")).toBe(i), { timeout: 5000 });
    }
    await clock.advance(60 * 60_000);
    await expect(code(query())).resolves.toBe("internal");
    await vi.waitFor(() => expect(count("search_index_rebuilt")).toBe(4), { timeout: 5000 });
    expect(count("search_index_unusable")).toBe(0);
    expect(watch.open()).toContain(root);
  });

  it("a rebuild that cannot reopen the index says so and leaves search off", async () => {
    const m = make({ spawn: () => new DamagedThread() });
    m.start();
    opens.fail = true;
    await expect(code(query())).resolves.toBe("internal");
    await vi.waitFor(() => expect(count("search_rebuild_failed")).toBe(1), { timeout: 5000 });
    await expect(code(query())).resolves.toBe("internal");
    expect(count("search_index_rebuilt")).toBe(0);
    expect(watch.open()).toEqual([]);
  });

  it("start during a rebuild leaves the new scanner the only one", async () => {
    const m = make({ spawn: () => new DamagedThread() });
    await expect(code(query())).resolves.toBe("internal");
    m.start();
    await vi.waitFor(() => expect(count("search_index_rebuilt")).toBe(1), { timeout: 5000 });
    expect(watch.watched.filter((dir) => dir === root)).toHaveLength(1);
    expect(watch.open()).toContain(root);
  });

  it("a stop during a rebuild wins: nothing is deleted or created after it", async () => {
    const m = make({ spawn: () => new DamagedThread() });
    m.start();
    await expect(code(query())).resolves.toBe("internal");
    await m.stop();
    expect(count("search_index_rebuilt")).toBe(0);
    expect(existsSync(join(home, "search.db"))).toBe(true);
    expect(watch.open()).toEqual([]);
  });
});
