import { describe, expect, it } from "vitest";
import { createRunView } from "./run-view.ts";
import { ROW_BYTES, SNAPSHOT_ROWS } from "./snapshot.ts";

const unbound = (message: unknown) => ({ entryId: null, message });

describe("run view", () => {
  it("has nothing to show outside a run", () => {
    const view = createRunView();
    expect(view.state()).toBeNull();
    view.push({ role: "user" });
    view.add({ entryId: "c1", message: { role: "compactionSummary" } });
    view.bind({ id: "e1", parentId: null, type: "message", role: "user" });
    expect(view.state()).toBeNull();
  });

  it("holds the messages of the run on top of the file as it was when the run began, and the leaf it had", () => {
    const view = createRunView();
    view.begin(1234, "leaf-1");
    view.push({ role: "user", content: "hi" });
    view.push({ role: "assistant" });
    expect(view.state()).toEqual({
      baselineBytes: 1234,
      leafAtStart: "leaf-1",
      rows: [unbound({ role: "user", content: "hi" }), unbound({ role: "assistant" })],
    });
  });

  it("forgets everything when the run ends, and a new run starts from its own baseline", () => {
    const view = createRunView();
    view.begin(10, "a");
    view.push({ role: "user" });
    view.end();
    expect(view.state()).toBeNull();
    view.begin(99, null);
    expect(view.state()).toEqual({ baselineBytes: 99, leafAtStart: null, rows: [] });
  });

  it("keeps a run's baseline and leaf when the run is told to begin again", () => {
    const view = createRunView();
    view.begin(10, "a");
    view.push({ role: "user" });
    view.begin(500, "b");
    expect(view.state()).toEqual({ baselineBytes: 10, leafAtStart: "a", rows: [unbound({ role: "user" })] });
  });

  it("keeps only as many rows as a snapshot can carry", () => {
    const view = createRunView();
    view.begin(0, null);
    for (let i = 0; i < SNAPSHOT_ROWS + 5; i++) view.push({ n: i });
    const rows = view.state()?.rows ?? [];
    expect(rows).toHaveLength(SNAPSHOT_ROWS);
    expect(rows.at(-1)).toEqual(unbound({ n: SNAPSHOT_ROWS + 4 }));
    expect(rows[0]).toEqual(unbound({ n: 5 }));
  });

  it("measures a message before it keeps it, and keeps a placeholder for one over the per-row budget (R109)", () => {
    const view = createRunView();
    view.begin(0, null);
    const huge = { role: "assistant", timestamp: 9, content: "x".repeat(ROW_BYTES + 1) };
    view.push(huge);
    expect(view.state()?.rows).toEqual([
      unbound({
        role: "assistant",
        timestamp: 9,
        omitted: true,
        bytes: Buffer.byteLength(JSON.stringify(huge)),
      }),
    ]);
  });

  it("holds the rows of a run to 1 MiB in all, dropping the oldest first", () => {
    const view = createRunView();
    view.begin(0, null);
    const nearlyHuge = (n: number) => ({ role: "user", n, content: "x".repeat(ROW_BYTES - 200) });
    for (let n = 0; n < 12; n++) view.push(nearlyHuge(n));
    const messages = (view.state()?.rows ?? []).map((row) => row.message as { n: number });
    expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThanOrEqual(1024 * 1024);
    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(messages.length).toBeLessThan(12);
    expect(messages.at(-1)?.n).toBe(11);
    expect(messages.map((m) => m.n)).toEqual(messages.map((_, i) => 12 - messages.length + i));
  });
});

describe("binding entry ids", () => {
  const setup = () => {
    const view = createRunView();
    view.begin(0, "start");
    return view;
  };
  const ids = (view: ReturnType<typeof setup>) => view.state()?.rows.map((row) => row.entryId);

  it("gives the id to the newest unbound row with the same role and timestamp, and to that row only", () => {
    const view = setup();
    view.push({ role: "user", timestamp: 5 });
    view.push({ role: "assistant", timestamp: 6 });
    view.push({ role: "user", timestamp: 5 });
    view.bind({ id: "e1", parentId: "start", type: "message", role: "user", messageTimestamp: 5 });
    expect(ids(view)).toEqual([null, null, "e1"]);
    view.bind({ id: "e2", parentId: "e1", type: "message", role: "user", messageTimestamp: 5 });
    expect(ids(view)).toEqual(["e2", null, "e1"]);
  });

  it("does not bind a row of another role or timestamp, and never rebinds a bound row", () => {
    const view = setup();
    view.push({ role: "user", timestamp: 5 });
    view.bind({ id: "e1", parentId: null, type: "message", role: "assistant", messageTimestamp: 5 });
    view.bind({ id: "e2", parentId: null, type: "message", role: "user", messageTimestamp: 6 });
    view.bind({ id: "e3", parentId: null, type: "compaction" });
    expect(ids(view)).toEqual([null]);
    view.bind({ id: "e4", parentId: null, type: "message", role: "user", messageTimestamp: 5 });
    view.bind({ id: "e5", parentId: null, type: "message", role: "user", messageTimestamp: 5 });
    expect(ids(view)).toEqual(["e4"]);
  });

  it("binds a tool result by its call id, whatever its timestamp, even when its message was kept as a placeholder", () => {
    const view = setup();
    view.push({ role: "toolResult", toolCallId: "call-1", timestamp: 7, content: "x".repeat(ROW_BYTES + 1) });
    view.push({ role: "toolResult", toolCallId: "call-2", timestamp: 7, content: "ok" });
    view.bind({ id: "t1", parentId: null, type: "message", role: "toolResult", toolCallId: "call-1" });
    expect(ids(view)).toEqual(["t1", null]);
  });

  it("adds a summary row already bound", () => {
    const view = setup();
    view.push({ role: "user", timestamp: 5 });
    view.add({ entryId: "c1", message: { role: "compactionSummary", summary: "s" } });
    expect(view.state()?.rows.at(-1)).toEqual({
      entryId: "c1",
      message: { role: "compactionSummary", summary: "s" },
    });
    // The row it added is not a candidate for a message entry.
    view.bind({ id: "e9", parentId: null, type: "message", role: "compactionSummary" });
    expect(ids(view)).toEqual([null, "c1"]);
  });

  // J1b. Mutant: `push` drops the mark -> "keeps the mark of a forged user message on its row" fails.
  it("keeps the mark of a forged user message on its row, and on its placeholder", () => {
    const view = createRunView();
    view.begin(0, null);
    view.push({ role: "user", content: "forged" }, true);
    view.push({ role: "user", content: "mine" });
    view.push({ role: "user", timestamp: 3, content: "x".repeat(ROW_BYTES + 1) }, true);
    const rows = view.state()?.rows ?? [];
    expect(rows[0]).toEqual({
      entryId: null,
      message: { role: "user", content: "forged" },
      unverified: true,
    });
    expect(rows[1]).toEqual(unbound({ role: "user", content: "mine" }));
    expect(rows[2]).toMatchObject({ unverified: true });
    view.bind({ id: "e1", parentId: null, type: "message", role: "user" });
    expect(view.state()?.rows[0]).toMatchObject({ unverified: true });
  });
});
