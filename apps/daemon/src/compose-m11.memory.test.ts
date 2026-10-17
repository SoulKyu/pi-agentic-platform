import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "./kernel/logger.ts";
import { createMemoryModule } from "./modules/memory/index.ts";
import { testCaller } from "./testing/caller.ts";
import { disposeParts, parts } from "./testing/compose-m11-parts.ts";

afterEach(disposeParts);

describe("the memory module's wiring (Task 32)", () => {
  const FACT = "123e4567-e89b-42d3-a456-426614174000";
  const stagedFact = (dir: string): string => join(dir, "pi-agent", "mem0", "staging", `${FACT}.json`);

  it("raises a staged fact in the Inbox, and quarantine moves it aside", async () => {
    const { m11, db, home, clock } = parts({
      beforeBoot: (dir) => {
        mkdirSync(join(dir, "pi-agent", "mem0", "staging"), { recursive: true, mode: 0o700 });
        writeFileSync(
          stagedFact(dir),
          JSON.stringify({
            id: FACT,
            agent: "atlas-0001",
            text: "likes tea",
            sourceSession: "session-1",
            createdAt: "2026-10-16T08:00:00Z",
          }),
        );
      },
    });
    db.run(
      `INSERT INTO agents (id, owner_id, name, name_key, profile, created_at, updated_at)
       VALUES ('atlas-0001', 'u1', 'Atlas', 'atlas', '{"name":"Atlas"}', 1, 1)`,
    );
    await clock.advance(30_000);
    const items = () =>
      db.all<{ kind: string; ref_id: string; detail: string }>(
        "SELECT kind, ref_id, detail FROM inbox_items WHERE kind = 'memory_review'",
      );
    expect(items()).toEqual([{ kind: "memory_review", ref_id: FACT, detail: null }]);
    const ctx = { caller: testCaller({ stepUpUntil: Number.MAX_SAFE_INTEGER }) } as never;
    const answer = await m11.rpc["agents.quarantine"]({ agentId: "atlas-0001" }, ctx);
    expect(answer.errors).toEqual([]);
    expect(existsSync(stagedFact(home))).toBe(false);
    expect(readdirSync(join(home, "pi-agent", "mem0", "staging")).map((name) => name.split("-")[0])).toEqual([
      "quarantine",
    ]);
    await clock.advance(30_000);
    expect(
      db.get<{ resolved_at: number | null }>("SELECT resolved_at FROM inbox_items WHERE ref_id = $FACT", {
        FACT,
      })?.resolved_at,
    ).not.toBeNull();
  });

  it("a restart that leaves one pending fact does not raise it again: its unread state and place are unchanged", async () => {
    const { m11, db, inbox, clock, home } = parts({
      beforeBoot: (dir) => {
        mkdirSync(join(dir, "pi-agent", "mem0", "staging"), { recursive: true, mode: 0o700 });
        writeFileSync(
          stagedFact(dir),
          JSON.stringify({
            id: FACT,
            agent: "atlas-0001",
            text: "likes tea",
            sourceSession: "session-1",
            createdAt: "2026-10-16T08:00:00Z",
          }),
        );
      },
    });
    db.run(
      `INSERT INTO agents (id, owner_id, name, name_key, profile, created_at, updated_at)
       VALUES ('atlas-0001', 'u1', 'Atlas', 'atlas', '{"name":"Atlas"}', 1, 1)`,
    );
    await clock.advance(30_000);
    expect(inbox.markRead("u1", { all: true })).toEqual({ updated: 1 });
    const row = () =>
      db.get<{ read_at: number | null; created_at: number }>(
        "SELECT read_at, created_at FROM inbox_items WHERE ref_id = $FACT",
        { FACT },
      );
    const before = row();
    expect(before?.read_at).not.toBeNull();
    // The daemon restarts: the first module is gone, a new one starts on the same database and the same folder.
    m11.stop();
    const restarted = createMemoryModule({
      core: {
        config: { piAgentDir: join(home, "pi-agent") },
        env: {},
        clock,
        logger: silentLogger,
        readOnly: false,
      },
      audit: { port: { append: () => {} } },
      inbox,
      agents: {
        port: { get: () => null, list: () => [], ownerOf: () => "u1" },
        setLinks: () => {},
      },
    });
    try {
      await clock.advance(60_000);
      expect(row()).toEqual(before);
    } finally {
      restarted.stop();
    }
  });

  it("answers the status without a pi-mem0 folder", async () => {
    const { m11 } = parts();
    expect(await m11.rpc["memory.status"]({}, { caller: testCaller() } as never)).toEqual({
      installed: false,
      watcher: "unknown",
      checkedAt: null,
      lastCaptureError: null,
      lastCaptureAt: null,
    });
  });
});
