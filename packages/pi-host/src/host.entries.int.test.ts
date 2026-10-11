import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostBed } from "./testing/host-bed.ts";

let bed: ReturnType<typeof createHostBed>;
beforeEach(() => {
  bed = createHostBed();
});
afterEach(() => bed.dispose());

type FileEntry = { id: string; parentId: string | null; type: string; message?: { role: string } };
const fileEntries = (file: string): FileEntry[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FileEntry)
    .filter((entry) => entry.type !== "session");

describe("entries and leaf over IPC", () => {
  it("reports every entry Pi appends for messages, a navigation and a compaction, once and in order", async () => {
    const ready = await bed.start(
      {
        steps: [
          { text: "one" },
          { text: "two" },
          { text: "three" },
          { text: "a summary of the session" },
          { text: "a summary of the turn prefix" },
        ],
      },
      { settings: { compaction: { keepRecentTokens: 1 } } },
    );
    const file = String(ready.sessionFile);
    const host = bed.host();
    const sentEntries = () =>
      host.records.flatMap((record) =>
        record.type === "entry_appended"
          ? [record.entry as { id: string; parentId: string | null; type: string }]
          : [],
      );
    const settle = async (message: string) => {
      const from = host.records.length;
      await host.request({ type: "prompt", message });
      await host.waitFor((record) => record.type === "agent_settled", { from });
    };

    await settle("first");
    await settle("second");
    // The records for the second run's last message come one macrotask after its message_end, before or after the settle.
    await host.waitFor(() => sentEntries().length >= 5);
    const afterPrompts = fileEntries(file);
    expect(sentEntries().map((entry) => entry.id)).toEqual(
      afterPrompts.filter((entry) => entry.type === "message").map((entry) => entry.id),
    );
    // Pi's system prompt is an entry too (R107): the daemon gets its id and never its text.
    expect(sentEntries().map((entry) => (entry as { role?: string }).role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);

    const first = afterPrompts.filter((entry) => entry.message?.role === "assistant")[0];
    if (!first) throw new Error("no assistant entry");
    const before = host.records.length;
    expect(await host.request({ type: "navigate_tree", targetId: first.id })).toMatchObject({
      success: true,
      data: { leafId: first.id },
    });
    const moved = await host.waitFor((record) => record.type === "leaf", { from: before });
    expect(moved).toEqual({ type: "leaf", leafId: first.id, resync: false });

    await settle("third");
    const third = fileEntries(file).at(-2);
    await host.waitFor(() => sentEntries().length >= 7);
    expect(
      sentEntries()
        .slice(5)
        .map((entry) => [entry.id, entry.parentId]),
    ).toEqual([
      [third?.id, first.id],
      [fileEntries(file).at(-1)?.id, third?.id],
    ]);

    const beforeCompact = host.records.length;
    await host.request({ type: "compact" });
    const compaction = await host.waitFor(
      (record) =>
        record.type === "entry_appended" && (record.entry as { type: string }).type === "compaction",
      { from: beforeCompact },
    );
    expect((compaction.entry as { id: string }).id).toBe(fileEntries(file).at(-1)?.id);
    const ids = sentEntries().map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reports a leaf for a fresh session", async () => {
    const ready = await bed.start({ steps: [{ text: "one" }] });
    expect(ready.leafId).toEqual(expect.any(String));
  });
});
