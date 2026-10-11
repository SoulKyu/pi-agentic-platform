import type { Dialog } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { fitSnapshot, SNAPSHOT_BYTES, SNAPSHOT_ROWS } from "./snapshot.ts";

const sizeOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const row = (n: number, filler = "") => ({ role: "user", content: `m${n}${filler}` });
const dialog = (id: string, filler = ""): Dialog => ({
  id,
  method: "confirm",
  title: `Run ${id}?`,
  message: filler,
});

describe("fitSnapshot", () => {
  it("carries the status, the rows and the open dialogs as they are when they fit", () => {
    const rows = [row(1), row(2)];
    expect(fitSnapshot({ status: "idle", rows, dialogs: [dialog("d1")] })).toEqual({
      kind: "snapshot",
      status: "idle",
      messages: rows,
      dialogs: [dialog("d1")],
    });
  });

  it("keeps the newest rows, at most SNAPSHOT_ROWS of them", () => {
    const rows = Array.from({ length: SNAPSHOT_ROWS + 10 }, (_, i) => row(i));
    const snapshot = fitSnapshot({ status: "idle", rows, dialogs: [] });
    expect(snapshot.kind === "snapshot" && snapshot.messages).toHaveLength(SNAPSHOT_ROWS);
    expect(snapshot.kind === "snapshot" && snapshot.messages.at(-1)).toEqual(row(SNAPSHOT_ROWS + 9));
  });

  it("drops the oldest rows first until the event fits the budget", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i, "x".repeat(1000)));
    const snapshot = fitSnapshot({ status: "running", rows, dialogs: [] }, 3500);
    if (snapshot.kind !== "snapshot") throw new Error("expected a snapshot");
    expect(sizeOf(snapshot)).toBeLessThanOrEqual(3500);
    expect(snapshot.messages.length).toBeGreaterThan(0);
    expect(snapshot.messages.at(-1)).toEqual(rows.at(-1));
    expect(snapshot.messages[0]).toEqual(rows[10 - snapshot.messages.length]);
  });

  it("keeps rows contiguous: a row that does not fit ends the history there", () => {
    const rows = [row(1), row(2, "x".repeat(5000)), row(3)];
    const snapshot = fitSnapshot({ status: "idle", rows, dialogs: [] }, 1000);
    expect(snapshot.kind === "snapshot" && snapshot.messages).toEqual([row(3)]);
  });

  it("gives the open dialogs the room first, oldest first, and leaves out those that do not fit", () => {
    const dialogs = [
      dialog("d1", "a".repeat(400)),
      dialog("d2", "b".repeat(400)),
      dialog("d3", "c".repeat(400)),
    ];
    const rows = [row(1), row(2)];
    const snapshot = fitSnapshot({ status: "running", rows, dialogs }, 1100);
    if (snapshot.kind !== "snapshot") throw new Error("expected a snapshot");
    expect(snapshot.dialogs.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(sizeOf(snapshot)).toBeLessThanOrEqual(1100);
  });

  it("stays under the default budget with the largest dialogs the registry allows", () => {
    const dialogs = Array.from({ length: 64 }, (_, i) => dialog(`d${i}`, "x".repeat(60_000)));
    const snapshot = fitSnapshot({ status: "running", rows: [row(1)], dialogs });
    expect(sizeOf(snapshot)).toBeLessThanOrEqual(SNAPSHOT_BYTES);
    expect(SNAPSHOT_BYTES + 512).toBeLessThan(1024 * 1024);
  });
});
