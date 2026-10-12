import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startLiveSession } from "./live-session.ts";
import { captureLogger } from "./testing/helpers.ts";
import { createLiveBed, piEvent } from "./testing/live-bed.ts";

const setup = createLiveBed(startLiveSession);

const user = { role: "user", content: "hi", timestamp: 5 };
const userEntry = { id: "e1", parentId: null, type: "message", role: "user", messageTimestamp: 5 };
const appended = (entry: Record<string, unknown>) => piEvent({ type: "entry_appended", entry });
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

describe("the leaf", () => {
  it("starts from the leaf in ready", () => {
    expect(setup({ leafId: "L0" }).live.leafId()).toBe("L0");
    expect(setup().live.leafId()).toBeNull();
  });

  it("counts a leaf of more than 128 characters as unknown (M2R4, M2-RT-06)", () => {
    expect(setup({ leafId: "x".repeat(129) }).live.leafId()).toBeNull();
    expect(setup({ leafId: "x".repeat(128) }).live.leafId()).toBe("x".repeat(128));
  });

  it("follows each entry the worker appends", () => {
    const { worker, live } = setup({ leafId: "L0" });
    worker.emit(appended(userEntry));
    expect(live.leafId()).toBe("e1");
    worker.emit(appended({ ...userEntry, id: "e2", parentId: "e1" }));
    expect(live.leafId()).toBe("e2");
  });

  it("follows a leaf record, and an unusable one leaves the leaf unknown", () => {
    const { worker, live } = setup({ leafId: "L0" });
    worker.emit({ type: "leaf", leafId: "e7", resync: false });
    expect(live.leafId()).toBe("e7");
    worker.emit({ type: "leaf", leafId: "y".repeat(129), resync: false });
    expect(live.leafId()).toBeNull();
    worker.emit({ type: "leaf", leafId: null, resync: false });
    expect(live.leafId()).toBeNull();
  });

  it("says a resync in the log, once in a while, and still takes the leaf", async () => {
    const { logger, lines } = captureLogger();
    const { worker, live } = setup({ logger });
    for (let i = 0; i < 3; i++) worker.emit({ type: "leaf", leafId: `e${i}`, resync: true });
    expect(live.leafId()).toBe("e2");
    expect(lines.filter((line) => line.msg === "entries_resync_needed")).toHaveLength(1);
  });

  it("is the leaf a run begins at, and it moves on with the entries", async () => {
    const { worker, live, clock } = setup({ leafId: "L0" });
    worker.emit(piEvent({ type: "agent_start" }));
    expect(live.runView()?.leafAtStart).toBe("L0");
    worker.emit(appended(userEntry));
    worker.emit(piEvent({ type: "agent_settled", aborted: false }));
    await clock.advance(0);
    worker.emit(piEvent({ type: "agent_start" }));
    expect(live.runView()?.leafAtStart).toBe("e1");
  });
});

describe("entry events", () => {
  it("publishes an entry once, binds its id to the row of the run, and never forwards Pi's own event", async () => {
    const { worker, live, published, clock } = setup();
    worker.emit(piEvent({ type: "agent_start" }));
    worker.emit(piEvent({ type: "message_end", message: user }));
    worker.emit(appended(userEntry));
    await clock.advance(100);
    expect(published.filter((event) => event.kind === "entry")).toEqual([
      { kind: "entry", entry: userEntry },
    ]);
    expect(live.runView()?.rows).toEqual([{ entryId: "e1", message: user }]);
    expect(JSON.stringify(published)).not.toContain("entry_appended");
  });

  it("binds the ids of a burst of 300 entries to the rows the run keeps", () => {
    const { worker, live } = setup();
    worker.emit(piEvent({ type: "agent_start" }));
    for (let i = 0; i < 300; i++) {
      worker.emit(
        piEvent({ type: "message_end", message: { role: "user", content: `m${i}`, timestamp: i } }),
      );
    }
    for (let i = 0; i < 300; i++) {
      worker.emit(
        appended({
          id: `e${i}`,
          parentId: i === 0 ? null : `e${i - 1}`,
          type: "message",
          role: "user",
          messageTimestamp: i,
        }),
      );
    }
    const rows = live.runView()?.rows ?? [];
    expect(rows).toHaveLength(75);
    expect(rows.map((row) => row.entryId)).toEqual(Array.from({ length: 75 }, (_, i) => `e${225 + i}`));
    expect(live.leafId()).toBe("e299");
  });

  it("keeps only what the contract carries of an entry", () => {
    const { worker, published } = setup();
    worker.emit(appended({ ...userEntry, timestamp: TIMESTAMP, body: "not for the wire" }));
    expect(published.filter((event) => event.kind === "entry")).toEqual([
      { kind: "entry", entry: userEntry },
    ]);
  });

  it("ignores an entry it cannot describe: nothing is published and the leaf stays", () => {
    const { worker, live, published } = setup({ leafId: "L0" });
    worker.emit(appended({ ...userEntry, id: "z".repeat(129) }));
    worker.emit(appended({ type: "message" }));
    expect(published.filter((event) => event.kind === "entry")).toEqual([]);
    expect(live.leafId()).toBe("L0");
  });

  it("moves the leaf to Pi's system prompt entry but tells the client nothing of it (R107)", () => {
    const { worker, live, published } = setup({ leafId: "L0" });
    worker.emit(appended({ id: "s0", parentId: "L0", type: "message", role: "system", messageTimestamp: 0 }));
    expect(live.leafId()).toBe("s0");
    expect(published.filter((event) => event.kind === "entry")).toEqual([]);
    expect(JSON.stringify(published)).not.toContain("system");
  });

  it("sends the text pending before an entry", async () => {
    const { worker, published } = setup();
    worker.emit(piEvent({ type: "message_start", message: { role: "assistant", content: [] } }));
    worker.emit(
      piEvent({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "late" },
      }),
    );
    worker.emit(appended(userEntry));
    const order = published.map((event) =>
      event.kind === "pi"
        ? ((event.event.assistantMessageEvent as { delta?: string } | undefined)?.delta ?? event.event.type)
        : event.kind,
    );
    expect(order.indexOf("late")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("late")).toBeLessThan(order.indexOf("entry"));
  });

  it("publishes a compaction as an entry and as a row shaped like Pi's own message, and keeps it for the run", () => {
    const { worker, live, published } = setup();
    worker.emit(piEvent({ type: "agent_start" }));
    worker.emit(
      appended({
        id: "c1",
        parentId: "e1",
        type: "compaction",
        timestamp: TIMESTAMP,
        summary: "S",
        tokensBefore: 90,
      }),
    );
    const row = {
      entryId: "c1",
      message: {
        role: "compactionSummary",
        summary: "S",
        tokensBefore: 90,
        timestamp: Date.parse(TIMESTAMP),
      },
    };
    expect(published.filter((event) => event.kind === "row")).toEqual([{ kind: "row", row }]);
    expect(published.filter((event) => event.kind === "entry")).toEqual([
      { kind: "entry", entry: { id: "c1", parentId: "e1", type: "compaction" } },
    ]);
    expect(live.runView()?.rows).toEqual([row]);
  });

  it("publishes a branch summary as a row too, and a plain entry as no row", () => {
    const { worker, published } = setup();
    worker.emit(
      appended({
        id: "b1",
        parentId: "e1",
        type: "branch_summary",
        timestamp: TIMESTAMP,
        summary: "B",
        fromId: "e3",
      }),
    );
    worker.emit(appended({ id: "m1", parentId: "b1", type: "model_change", timestamp: TIMESTAMP }));
    expect(published.filter((event) => event.kind === "row")).toEqual([
      {
        kind: "row",
        row: {
          entryId: "b1",
          message: { role: "branchSummary", summary: "B", fromId: "e3", timestamp: Date.parse(TIMESTAMP) },
        },
      },
    ]);
  });

  it("takes the snapshot of a run from the file as it was when the run began, then the run's rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "pap-live-"));
    try {
      const file = join(dir, "s.jsonl");
      writeFileSync(file, "12345");
      const { worker, live } = setup({ sessionFile: file, leafId: "L0" });
      worker.emit(piEvent({ type: "agent_start" }));
      expect(live.runView()).toEqual({ baselineBytes: 5, leafAtStart: "L0", rows: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
