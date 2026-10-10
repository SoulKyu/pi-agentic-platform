import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "../clock.ts";
import { createLogger, silentLogger } from "../logger.ts";
import { openDatabase, type Db } from "./database.ts";
import { KERNEL_MIGRATIONS, migrate } from "./migrate.ts";
import { createReceiptStore, startReceiptPurge } from "./receipts.ts";

const DAY = 24 * 60 * 60 * 1000;

let dir: string;
let clock: FakeClock;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-receipts-"));
  clock = createFakeClock();
  ({ db } = migrate({
    dbPath: join(dir, "s.db"),
    backupsDir: join(dir, "b"),
    sources: [KERNEL_MIGRATIONS],
    clock,
    logger: silentLogger,
  }));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("receipts", () => {
  it("returns the stored result for the same user and command, and nothing for another user", () => {
    const receipts = createReceiptStore(db, createFakeClock());
    receipts.save("u1", "cmd-00000001", "sessions.create", { sessionId: "s1" });
    expect(receipts.find("u1", "cmd-00000001")).toEqual({
      method: "sessions.create",
      result: { sessionId: "s1" },
    });
    expect(receipts.find("u2", "cmd-00000001")).toBeNull();
  });

  it("keeps the first result when the same command is saved twice", () => {
    const receipts = createReceiptStore(db, clock);
    receipts.save("u1", "cmd-00000001", "sessions.create", { sessionId: "first" });
    receipts.save("u1", "cmd-00000001", "sessions.create", { sessionId: "second" });
    expect(receipts.find("u1", "cmd-00000001")?.result).toEqual({ sessionId: "first" });
  });

  it("stores a method that returns nothing as null", () => {
    const receipts = createReceiptStore(db, clock);
    receipts.save("u1", "cmd-00000002", "sessions.archive", undefined);
    expect(receipts.find("u1", "cmd-00000002")).toEqual({ method: "sessions.archive", result: null });
  });
});

describe("receipt purge", () => {
  it("removes only receipts older than 7 days", async () => {
    const receipts = createReceiptStore(db, clock);
    receipts.save("u1", "cmd-old00001", "m", 1);
    await clock.advance(3 * DAY);
    receipts.save("u1", "cmd-new00001", "m", 2);
    await clock.advance(5 * DAY);
    expect(receipts.purge()).toBe(1);
    expect(receipts.find("u1", "cmd-old00001")).toBeNull();
    expect(receipts.find("u1", "cmd-new00001")).not.toBeNull();
  });

  it("purges at start, then every 24 h: a day-0 receipt survives day 7 and is gone at the day-8 tick", async () => {
    const receipts = createReceiptStore(db, clock);
    const purge = startReceiptPurge(receipts, clock, silentLogger);
    receipts.save("u1", "cmd-00000001", "m", {});
    await clock.advance(6 * DAY);
    expect(receipts.find("u1", "cmd-00000001")).not.toBeNull();
    await clock.advance(DAY);
    expect(receipts.find("u1", "cmd-00000001")).not.toBeNull();
    await clock.advance(DAY);
    expect(receipts.find("u1", "cmd-00000001")).toBeNull();
    purge.stop();
  });

  it("ticks every 24 h, not less often", async () => {
    const receipts = createReceiptStore(db, clock);
    const purge = startReceiptPurge(receipts, clock, silentLogger);
    await clock.advance(DAY);
    receipts.save("u1", "cmd-00000001", "m", {});
    await clock.advance(7 * DAY);
    expect(receipts.find("u1", "cmd-00000001")).not.toBeNull();
    await clock.advance(DAY);
    expect(receipts.find("u1", "cmd-00000001")).toBeNull();
    purge.stop();
  });

  it("purges stale receipts as soon as it starts", async () => {
    const receipts = createReceiptStore(db, clock);
    receipts.save("u1", "cmd-00000001", "m", {});
    await clock.advance(30 * DAY);
    expect(receipts.find("u1", "cmd-00000001")).not.toBeNull();
    startReceiptPurge(receipts, clock, silentLogger).stop();
    expect(receipts.find("u1", "cmd-00000001")).toBeNull();
  });

  it("stop cancels the pending timer", () => {
    const purge = startReceiptPurge(createReceiptStore(db, clock), clock, silentLogger);
    expect(clock.pending()).toBe(1);
    purge.stop();
    expect(clock.pending()).toBe(0);
  });

  it("keeps ticking and logs when a purge fails", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "debug", clock, write: (line) => lines.push(line) });
    const receipts = createReceiptStore(db, clock);
    db.exec("DROP TABLE receipts");
    const purge = startReceiptPurge(receipts, clock, logger);
    await clock.advance(DAY);
    expect(lines.filter((line) => line.includes("receipts_purge_failed"))).toHaveLength(2);
    expect(clock.pending()).toBe(1);
    purge.stop();
  });

  it("does nothing on a read-only database", async () => {
    createReceiptStore(db, clock).save("u1", "cmd-00000001", "m", {});
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    await clock.advance(30 * DAY);
    const reader = openDatabase(join(dir, "s.db"), { readOnly: true });
    expect(createReceiptStore(reader, clock).purge()).toBe(0);
    expect(createReceiptStore(reader, clock).readOnly).toBe(true);
    expect(createReceiptStore(db, clock).readOnly).toBe(false);
    expect(createReceiptStore(db, clock).find("u1", "cmd-00000001")).not.toBeNull();
    reader.close();
  });
});
