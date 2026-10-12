import { expect, it } from "vitest";
import { createIntBed, promptAndSettle } from "./testing/int-bed.ts";

it("shows rows with Pi's entry ids, live and after a restart from the file", async () => {
  const bed = await createIntBed({ steps: [{ text: "first reply" }, { text: "second reply" }] });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const live = await bed.subscribe(sessionId);
    await promptAndSettle(bed, live, sessionId, "one");
    await promptAndSettle(bed, live, sessionId, "two");
    const liveIds = live
      .events()
      .flatMap((event) => (event.kind === "entry" && event.entry.type === "message" ? [event.entry.id] : []));
    // Two exchanges; Pi's system prompt entry is not announced (R107).
    expect(liveIds).toHaveLength(4);
    expect(new Set(liveIds).size).toBe(4);
    expect(JSON.stringify(live.events())).not.toContain("entry_appended");
    bed.killWorker(sessionId);
    await live.waitFor((event) => event.kind === "status" && event.status === "cold");
    const after = await bed.subscribe(sessionId);
    const snapshot = after.events()[0];
    if (snapshot?.kind !== "snapshot") throw new Error("no snapshot");
    expect(snapshot.rows.map((row) => (row.message as { role: string }).role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(snapshot.rows.map((row) => row.entryId)).toEqual(liveIds.slice(-4));
    expect(snapshot.leafId).toBe(liveIds.at(-1));
  } finally {
    await bed.dispose();
  }
});

it("gives a late subscriber to a live worker the ids of the rows and the worker's leaf", async () => {
  const bed = await createIntBed({ steps: [{ text: "first reply" }, { text: "second reply" }] });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const live = await bed.subscribe(sessionId);
    await promptAndSettle(bed, live, sessionId, "one");
    await promptAndSettle(bed, live, sessionId, "two");
    const late = await bed.subscribe(sessionId);
    const snapshot = late.events()[0];
    if (snapshot?.kind !== "snapshot") throw new Error("no snapshot");
    const ids = live
      .events()
      .flatMap((event) => (event.kind === "entry" && event.entry.type === "message" ? [event.entry.id] : []));
    expect(snapshot.rows.map((row) => row.entryId)).toEqual(ids.slice(-4));
    expect(snapshot.leafId).toBe(ids.at(-1));
  } finally {
    await bed.dispose();
  }
});
