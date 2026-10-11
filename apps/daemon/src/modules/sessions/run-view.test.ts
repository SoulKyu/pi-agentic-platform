import { describe, expect, it } from "vitest";
import { createRunView } from "./run-view.ts";
import { ROW_BYTES, SNAPSHOT_ROWS } from "./snapshot.ts";

describe("run view", () => {
  it("has nothing to show outside a run", () => {
    const view = createRunView();
    expect(view.state()).toBeNull();
    view.push({ role: "user" });
    expect(view.state()).toBeNull();
  });

  it("holds the messages of the run on top of the file as it was when the run began", () => {
    const view = createRunView();
    view.begin(1234);
    view.push({ role: "user", content: "hi" });
    view.push({ role: "assistant" });
    expect(view.state()).toEqual({
      baselineBytes: 1234,
      messages: [{ role: "user", content: "hi" }, { role: "assistant" }],
    });
  });

  it("forgets everything when the run ends, and a new run starts from its own baseline", () => {
    const view = createRunView();
    view.begin(10);
    view.push({ role: "user" });
    view.end();
    expect(view.state()).toBeNull();
    view.begin(99);
    expect(view.state()).toEqual({ baselineBytes: 99, messages: [] });
  });

  it("keeps a run's baseline when the run is told to begin again", () => {
    const view = createRunView();
    view.begin(10);
    view.push({ role: "user" });
    view.begin(500);
    expect(view.state()).toEqual({ baselineBytes: 10, messages: [{ role: "user" }] });
  });

  it("keeps only as many messages as a snapshot can carry", () => {
    const view = createRunView();
    view.begin(0);
    for (let i = 0; i < SNAPSHOT_ROWS + 5; i++) view.push({ n: i });
    const messages = view.state()?.messages ?? [];
    expect(messages).toHaveLength(SNAPSHOT_ROWS);
    expect(messages.at(-1)).toEqual({ n: SNAPSHOT_ROWS + 4 });
    expect(messages[0]).toEqual({ n: 5 });
  });

  it("measures a message before it keeps it, and keeps a placeholder for one over the per-row budget (R109)", () => {
    const view = createRunView();
    view.begin(0);
    const huge = { role: "assistant", timestamp: 9, content: "x".repeat(ROW_BYTES + 1) };
    view.push(huge);
    expect(view.state()?.messages).toEqual([
      { role: "assistant", timestamp: 9, omitted: true, bytes: Buffer.byteLength(JSON.stringify(huge)) },
    ]);
  });

  it("holds the messages of a run to 1 MiB in all, dropping the oldest first", () => {
    const view = createRunView();
    view.begin(0);
    const nearlyHuge = (n: number) => ({ role: "user", n, content: "x".repeat(ROW_BYTES - 200) });
    for (let n = 0; n < 12; n++) view.push(nearlyHuge(n));
    const messages = (view.state()?.messages ?? []) as Array<{ n: number }>;
    expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThanOrEqual(1024 * 1024);
    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(messages.length).toBeLessThan(12);
    expect(messages.at(-1)?.n).toBe(11);
    expect(messages.map((m) => m.n)).toEqual(messages.map((_, i) => 12 - messages.length + i));
  });
});
