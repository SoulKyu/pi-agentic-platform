import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createKeepSweeper, KEEP_MS, keepCopy, sweepKept } from "./mirror-keep.ts";
import { AGENT, type Bed, FILE, HEADER, makeBed } from "./mirror-fixtures.ts";

let bed: Bed;
afterEach(() => bed.dispose());
const DAY = 24 * 60 * 60 * 1000;
const keptDir = () => join(bed.folder, "replaced");

describe("keepCopy (R14)", () => {
  it("moves the file to replaced/<name>.<stamp>, in a 0700 folder, and leaves nothing at the old path", () => {
    bed = makeBed();
    const clock = createFakeClock();
    writeFileSync(bed.path, HEADER, { mode: 0o600 });
    const kept = keepCopy(bed.path, clock);
    expect(kept).toBe(join(keptDir(), `${FILE}.${clock.now()}`));
    expect(existsSync(bed.path)).toBe(false);
    expect(statSync(kept).mode & 0o777).toBe(0o600);
    expect(statSync(keptDir()).mode & 0o777).toBe(0o700);
  });

  it("never overwrites an earlier copy made in the same millisecond", () => {
    bed = makeBed();
    const clock = createFakeClock();
    writeFileSync(bed.path, "one\n");
    const first = keepCopy(bed.path, clock);
    writeFileSync(bed.path, "two\n");
    const second = keepCopy(bed.path, clock);
    expect(second).not.toBe(first);
    expect(readdirSync(keptDir())).toHaveLength(2);
  });
});

describe("sweepKept: a kept copy lives 7 days", () => {
  it("deletes copies older than 7 days and keeps younger ones, for every agent", () => {
    bed = makeBed();
    const clock = createFakeClock();
    const { logger } = captureLogger();
    const other = join(bed.root, "agents", ".mirrors", "other-9z9z", "replaced");
    mkdirSync(other, { recursive: true });
    mkdirSync(keptDir());
    const old = join(keptDir(), `${FILE}.${clock.now() - KEEP_MS - 1}`);
    const edge = join(keptDir(), `${FILE}.${clock.now() - KEEP_MS + 1000}`);
    const young = join(other, `x.jsonl.${clock.now() - DAY}`);
    const oldOther = join(other, `y.jsonl.${clock.now() - 8 * DAY}`);
    for (const path of [old, edge, young, oldOther]) writeFileSync(path, "x");
    expect(sweepKept(bed.root, clock, logger)).toEqual({ removed: 2, agents: [AGENT, "other-9z9z"].sort() });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(oldOther)).toBe(false);
    expect(existsSync(edge)).toBe(true);
    expect(existsSync(young)).toBe(true);
  });

  it("leaves names that carry no stamp alone and unlinks (never follows) an old link", () => {
    bed = makeBed();
    const clock = createFakeClock();
    mkdirSync(keptDir());
    const target = join(bed.root, "precious");
    writeFileSync(target, "keep");
    const stranger = join(keptDir(), "notes.txt");
    writeFileSync(stranger, "x");
    const link = join(keptDir(), `${FILE}.${clock.now() - 9 * DAY}`);
    symlinkSync(target, link);
    sweepKept(bed.root, clock, captureLogger().logger);
    expect(existsSync(stranger)).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(readdirSync(keptDir())).toEqual(["notes.txt"]);
  });

  it("is quiet when nothing was ever kept", () => {
    bed = makeBed();
    expect(sweepKept(bed.root, createFakeClock(), captureLogger().logger)).toEqual({
      removed: 0,
      agents: [],
    });
    expect(sweepKept(join(bed.root, "missing"), createFakeClock(), captureLogger().logger).removed).toBe(0);
  });
});

describe("createKeepSweeper", () => {
  it("sweeps at start and every hour: a copy is gone after 7 days on the steppable clock", async () => {
    bed = makeBed();
    const clock = createFakeClock();
    const swept: string[][] = [];
    writeFileSync(bed.path, HEADER);
    keepCopy(bed.path, clock);
    const sweeper = createKeepSweeper({
      papHome: bed.root,
      clock,
      logger: captureLogger().logger,
      onSwept: (agents) => void swept.push([...agents]),
    });
    sweeper.start();
    expect(readdirSync(keptDir())).toHaveLength(1);
    await clock.advance(6 * DAY);
    expect(readdirSync(keptDir())).toHaveLength(1);
    await clock.advance(DAY + 3_600_000);
    expect(readdirSync(keptDir())).toHaveLength(0);
    expect(swept).toEqual([[AGENT]]);
    sweeper.stop();
    expect(clock.pending()).toBe(0);
  });
});
