import { existsSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createStagedCache, writeDecision } from "./mem0-files.ts";
import { createReview, REVIEW_INTERVAL_MS } from "./review.ts";
import { AGENT, createMem0Layout, FACT, FACT2, type Mem0Layout } from "./testing/layout.ts";

let layout: Mem0Layout;
let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  layout.dispose();
});

function setup(
  owners: Record<string, string> = { [AGENT]: "u1" },
  warn: (...args: unknown[]) => void = () => {},
) {
  layout = createMem0Layout();
  const clock = createFakeClock();
  const upserts: Array<Record<string, unknown>> = [];
  const resolved: unknown[][] = [];
  /** What the Inbox holds open for the kind when the review starts (a restart that left items behind). */
  const opened: Array<{ ownerId: string; agentId: string; refId: string }> = [];
  const cache = createStagedCache();
  const review = createReview({
    dir: layout.mem0,
    clock,
    logger: { warn },
    readOnly: false,
    ownerOf: (agentId) => owners[agentId] ?? null,
    cache,
    inbox: {
      upsertAgentItem: (input) => (upserts.push({ ...input }), true),
      resolveRef: (...args) => (resolved.push(args), true),
      openRefs: () => opened,
    },
  });
  stop = review.stop;
  return { clock, review, upserts, resolved, opened, cache };
}

describe("the review queue (M11R148)", () => {
  it("raises one to-handle memory_review item per pending fact, once", () => {
    const t = setup();
    layout.fact(FACT, { text: "likes\u202E tea" });
    t.review.tick();
    t.review.tick();
    expect(t.upserts).toEqual([
      {
        ownerId: "u1",
        kind: "memory_review",
        agentId: AGENT,
        refId: FACT,
        detail: null,
        toHandle: true,
      },
    ]);
  });

  it("never puts the fact text in the Inbox item: detail is null (W5-R61)", () => {
    const t = setup();
    layout.fact(FACT, { text: `private ${"z".repeat(900)}` });
    t.review.tick();
    expect(t.upserts).toHaveLength(1);
    expect(t.upserts[0]?.["detail"]).toBeNull();
    expect(JSON.stringify(t.upserts)).not.toContain("private");
  });

  it("does not raise a fact pi-mem0 has claimed (a .processing sibling), and closes its open item", () => {
    const t = setup();
    layout.fact(FACT);
    layout.fact(FACT2);
    layout.json(`staging/${FACT2}.processing`, JSON.stringify({ approved: true }));
    t.review.tick();
    expect(t.upserts.map((each) => each["refId"])).toEqual([FACT]);
    layout.json(`staging/${FACT}.processing`, JSON.stringify({ approved: true }));
    t.review.tick();
    t.review.tick();
    expect(t.upserts).toHaveLength(1);
    expect(t.resolved).toEqual([["u1", "memory_review", FACT, "answered"]]);
  });

  it("filters by agent before the 200 cap: 201 facts of a deleted agent hide nothing, and are logged once", () => {
    const warn = vi.fn();
    const t = setup({ [AGENT]: "u1" }, warn);
    for (let i = 0; i < 201; i++)
      layout.fact(`${String(i).padStart(8, "0")}-e89b-42d3-a456-426614174000`, {
        agent: "ghost-1a2b",
        createdAt: `2026-10-16T07:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
      });
    layout.fact(FACT);
    t.review.tick();
    t.review.tick();
    expect(t.upserts.map((each) => each["refId"])).toEqual([FACT]);
    expect(warn.mock.calls.filter(([message]) => message === "memory_staged_orphan")).toHaveLength(1);
  });

  it("resolves the item as answered while pi-mem0 holds a fresh claim on the decided fact", () => {
    const t = setup();
    layout.fact(FACT);
    t.review.tick();
    writeDecision(layout.mem0, FACT, true, t.clock.now());
    const claim = join(layout.mem0, "staging", `${FACT}.processing`);
    writeFileSync(claim, "");
    utimesSync(claim, t.clock.now() / 1000, t.clock.now() / 1000);
    t.review.tick();
    t.review.tick();
    expect(t.resolved).toEqual([["u1", "memory_review", FACT, "answered"]]);
  });

  it("keeps a decided fact pending without a claim, and raises it again once a claim has gone stale", async () => {
    const t = setup();
    layout.fact(FACT);
    t.review.tick();
    writeDecision(layout.mem0, FACT, true, t.clock.now());
    t.review.tick();
    expect(t.resolved).toEqual([]);
    const claim = join(layout.mem0, "staging", `${FACT}.processing`);
    writeFileSync(claim, "");
    utimesSync(claim, t.clock.now() / 1000, t.clock.now() / 1000);
    t.review.tick();
    expect(t.resolved).toEqual([["u1", "memory_review", FACT, "answered"]]);
    // 10 minutes and a millisecond later pi-mem0 is taken to have died: the owner is asked again.
    await t.clock.advance(10 * 60_000 + 1);
    t.review.tick();
    expect(t.upserts.filter((each) => each["refId"] === FACT)).toHaveLength(2);
  });

  it("resolves the item when the fact vanished, without a resolution", () => {
    const t = setup();
    layout.fact(FACT);
    t.review.tick();
    // pi-mem0 removes a fact it applied or dropped.
    rmFact(FACT);
    t.review.tick();
    expect(t.resolved).toEqual([["u1", "memory_review", FACT, null]]);
  });

  it("skips a fact whose agent has no owner, and raises it once it has", () => {
    const owners: Record<string, string> = {};
    const t = setup(owners);
    layout.fact(FACT);
    t.review.tick();
    expect(t.upserts).toEqual([]);
    owners[AGENT] = "u1";
    t.review.tick();
    expect(t.upserts).toHaveLength(1);
  });

  it("raises at most 200 facts", () => {
    const t = setup();
    for (let i = 0; i < 205; i++)
      layout.fact(`${String(i).padStart(8, "0")}-e89b-42d3-a456-426614174000`, {
        createdAt: `2026-10-16T08:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
      });
    t.review.tick();
    expect(t.upserts).toHaveLength(200);
  });

  it("ticks every 30 s on the clock, survives a failing tick and stops cleanly", async () => {
    const t = setup();
    layout.fact(FACT);
    expect(REVIEW_INTERVAL_MS).toBe(30_000);
    t.review.start();
    expect(t.clock.pending()).toBe(1);
    await t.clock.advance(30_000);
    expect(t.upserts).toHaveLength(1);
    layout.fact(FACT2);
    await t.clock.advance(29_999);
    expect(t.upserts).toHaveLength(1);
    await t.clock.advance(1);
    expect(t.upserts).toHaveLength(2);
    t.review.stop();
    expect(t.clock.pending()).toBe(0);
  });

  it("logs a throwing inbox and keeps ticking", async () => {
    layout = createMem0Layout();
    const clock = createFakeClock();
    const warn = vi.fn();
    const review = createReview({
      dir: layout.mem0,
      clock,
      logger: { ...silentLogger, warn },
      readOnly: false,
      ownerOf: () => "u1",
      inbox: {
        upsertAgentItem: () => {
          throw new Error("db down");
        },
        resolveRef: () => false,
        openRefs: () => [],
      },
    });
    stop = review.stop;
    layout.fact(FACT);
    review.start();
    await clock.advance(30_000);
    expect(warn).toHaveBeenCalledWith("memory_review_failed", expect.anything());
    expect(clock.pending()).toBe(1);
  });

  it("does nothing on a read-only database", () => {
    layout = createMem0Layout();
    const upsert = vi.fn(() => true);
    const review = createReview({
      dir: layout.mem0,
      clock: createFakeClock(),
      logger: silentLogger,
      readOnly: true,
      ownerOf: () => "u1",
      inbox: { upsertAgentItem: upsert, resolveRef: () => true, openRefs: () => [] },
    });
    layout.fact(FACT);
    review.tick();
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("a restart (M11 sweep, 32)", () => {
  it("does not raise again a fact the Inbox already holds open, and raises one that is really new", () => {
    const t = setup();
    t.opened.push({ ownerId: "u1", agentId: AGENT, refId: FACT });
    layout.fact(FACT);
    t.review.start();
    t.review.tick();
    expect(t.upserts).toEqual([]);
    layout.fact(FACT2);
    t.review.tick();
    expect(t.upserts.map((each) => each["refId"])).toEqual([FACT2]);
  });

  it("closes an item whose fact vanished while pap was down", () => {
    const t = setup();
    t.opened.push({ ownerId: "u1", agentId: AGENT, refId: FACT });
    t.review.start();
    t.review.tick();
    expect(t.resolved).toEqual([["u1", "memory_review", FACT, null]]);
  });

  it("logs a failing load and raises as before", () => {
    layout = createMem0Layout();
    const warn = vi.fn();
    const upserts: unknown[] = [];
    const review = createReview({
      dir: layout.mem0,
      clock: createFakeClock(),
      logger: { warn },
      readOnly: false,
      ownerOf: () => "u1",
      inbox: {
        upsertAgentItem: (input) => (upserts.push(input), true),
        resolveRef: () => true,
        openRefs: () => {
          throw new Error("db down");
        },
      },
    });
    stop = review.stop;
    layout.fact(FACT);
    review.start();
    review.tick();
    expect(warn).toHaveBeenCalledWith("memory_review_load_failed", expect.anything());
    expect(upserts).toHaveLength(1);
  });
});

describe("the tick's reads (M11 sweep, 32)", () => {
  it("reads a fact file once while its mtime and size are unchanged, again once either changed", () => {
    const t = setup();
    const path = layout.fact(FACT);
    const at = (seconds: number) => utimesSync(path, seconds, seconds);
    at(1_700_000_000);
    t.review.tick();
    t.review.tick();
    t.review.tick();
    expect(t.cache.reads).toBe(1);
    // Same size, other mtime.
    writeFileSync(path, readFileSync(path, "utf8").replace("likes tea", "likes cat"));
    at(1_700_000_100);
    t.review.tick();
    expect(t.cache.reads).toBe(2);
    // Same mtime, other size.
    writeFileSync(path, readFileSync(path, "utf8").replace("likes cat", "likes cats"));
    at(1_700_000_100);
    t.review.tick();
    expect(t.cache.reads).toBe(3);
    t.review.tick();
    expect(t.cache.reads).toBe(3);
  });
});

function rmFact(id: string): void {
  rmSync(join(layout.mem0, "staging", `${id}.json`));
}

describe("quarantine's memory step", () => {
  it("moves the agent's facts and decisions into staging/quarantine-<stamp>/ (0700) byte for byte", () => {
    const t = setup({ [AGENT]: "u1", "other-1a2b": "u1" });
    const factPath = layout.fact(FACT, { text: "weird \u0000 text" });
    layout.fact(FACT2, { agent: "other-1a2b" });
    const before = readFileSync(factPath);
    writeDecision(layout.mem0, FACT, true, t.clock.now());
    const decisionPath = join(layout.mem0, "staging", `${FACT}.decision.json`);
    const decisionBefore = readFileSync(decisionPath);
    t.review.tick();
    expect(t.review.moveStaged("u1", AGENT)).toBe(1);
    const staging = join(layout.mem0, "staging");
    const folders = readdirSync(staging).filter((name) => name.startsWith("quarantine-"));
    expect(folders).toHaveLength(1);
    const target = join(staging, folders[0] as string);
    expect(statSync(target).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(target, `${FACT}.json`))).toEqual(before);
    expect(readFileSync(join(target, `${FACT}.decision.json`))).toEqual(decisionBefore);
    expect(existsSync(factPath)).toBe(false);
    expect(readdirSync(staging).sort()).toEqual([`${FACT2}.json`, folders[0]].sort());
    expect(t.resolved).toContainEqual(["u1", "memory_review", FACT, null]);
  });

  it("does nothing when the agent has no staged fact, and creates no folder", () => {
    const t = setup();
    layout.dir("staging");
    expect(t.review.moveStaged("u1", AGENT)).toBe(0);
    expect(readdirSync(join(layout.mem0, "staging"))).toEqual([]);
  });

  it("leaves a fact pi-mem0 is applying and says so", () => {
    const t = setup();
    layout.fact(FACT);
    layout.json(`staging/${FACT}.processing`, "");
    expect(() => t.review.moveStaged("u1", AGENT)).toThrow("applying");
  });

  it("is a no-op when pi-mem0 is not installed", () => {
    const t = setup();
    layout.dispose();
    expect(t.review.moveStaged("u1", AGENT)).toBe(0);
    layout = createMem0Layout();
  });
});
