import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import type { ThreadLike } from "./search-client.ts";

const bytes = vi.hoisted(() => ({ fail: false }));
vi.mock("./index-db.ts", async (original) => {
  const real = await original<typeof import("./index-db.ts")>();
  return {
    ...real,
    indexBytes: (path: string) => {
      if (bytes.fail) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return real.indexBytes(path);
    },
  };
});
const { createSearchModule } = await import("./index.ts");

function capture() {
  const lines: Array<{ msg: string; fields?: unknown }> = [];
  const logger: Logger = {
    debug: () => {},
    info: (msg, fields) => lines.push({ msg, fields }),
    warn: (msg, fields) => lines.push({ msg, fields }),
    error: (msg, fields) => lines.push({ msg, fields }),
    child: () => logger,
  };
  return { logger, lines };
}

describe("search module", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pap-search-module-"));
    bytes.fail = false;
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

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

  it("read-only: never creates search.db, says so once, answers no hits and spawns no thread", async () => {
    const { logger, lines } = capture();
    const spawn = vi.fn((): ThreadLike => {
      throw new Error("no thread expected");
    });
    const module = createSearchModule({
      home,
      clock: createFakeClock(),
      logger,
      sessions,
      readOnly: true,
      spawn,
    });
    await expect(module.rpc["search.query"]({ q: "kube" }, ctx)).resolves.toEqual({ hits: [] });
    await module.stop();
    expect(existsSync(join(home, "search.db"))).toBe(false);
    expect(lines.map((line) => line.msg)).toEqual(["search_disabled_read_only"]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("a size that cannot be read is logged and does not stop the boot", async () => {
    bytes.fail = true;
    const { logger, lines } = capture();
    const module = createSearchModule({ home, clock: createFakeClock(), logger, sessions });
    expect(lines.map((line) => line.msg)).toEqual(["search_index_count_failed"]);
    await module.stop();
  });

  it("says the size once at boot", async () => {
    const { logger, lines } = capture();
    const module = createSearchModule({ home, clock: createFakeClock(), logger, sessions });
    expect(lines.filter((line) => line.msg === "search_index_size")).toHaveLength(1);
    await module.stop();
  });
});
