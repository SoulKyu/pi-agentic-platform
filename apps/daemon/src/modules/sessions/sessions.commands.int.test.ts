import { expect, it } from "vitest";
import { createIntBed, promptAndSettle } from "./testing/int-bed.ts";

it("edits from an earlier message: navigate, then the next prompt makes a sibling branch", async () => {
  const bed = await createIntBed({ steps: [{ text: "r0" }, { text: "r1" }, { text: "r1 again" }] });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    await promptAndSettle(bed, sub, sessionId, "q0");
    await promptAndSettle(bed, sub, sessionId, "q1");
    const userIds = sub
      .events()
      .flatMap((event) => (event.kind === "entry" && event.entry.role === "user" ? [event.entry.id] : []));
    expect(await bed.rpc["sessions.navigate"]({ sessionId, targetId: userIds[1] ?? "" }, bed.ctx)).toEqual({
      cancelled: false,
      editorText: "q1",
    });
    const snapshot = await sub.waitFor(
      (event) => event.kind === "snapshot" && sub.events().indexOf(event) > 0,
    );
    if (snapshot.kind !== "snapshot") throw new Error("no snapshot");
    expect(snapshot.rows.map((row) => (row.message as { role: string }).role)).toEqual(["user", "assistant"]);
    await promptAndSettle(bed, sub, sessionId, "q1 edited");
    const { points } = await bed.rpc["sessions.branches"]({ sessionId }, bed.ctx);
    expect(points).toHaveLength(1);
    expect(points[0]?.choices.map((choice) => [choice.preview, choice.onPath])).toEqual([
      ["q1", false],
      ["q1 edited", true],
    ]);
  } finally {
    await bed.dispose();
  }
});

it("compacts, shows the summary row live and keeps the history before it after a restart", async () => {
  const bed = await createIntBed(
    {
      steps: [
        { text: "r0" },
        { text: "r1" },
        { text: "summary of r0 and r1" },
        { text: "summary of the turn prefix" },
      ],
    },
    { settings: { compaction: { keepRecentTokens: 1 } } },
  );
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    await promptAndSettle(bed, sub, sessionId, "q0");
    await promptAndSettle(bed, sub, sessionId, "q1");
    const result = await bed.rpc["sessions.compact"]({ sessionId }, bed.ctx);
    expect(result.tokensBefore).toBeGreaterThan(0);
    await sub.waitFor(
      (event) => event.kind === "row" && (event.row.message as { role: string }).role === "compactionSummary",
    );
    expect(
      sub
        .events()
        .filter((event) => event.kind === "activity")
        .map((event) => (event.kind === "activity" ? event.activity.compacting : null)),
    ).toEqual([true, false]);
    bed.killWorker(sessionId);
    await sub.waitFor((event) => event.kind === "status" && event.status === "cold");
    const after = await bed.subscribe(sessionId);
    const snapshot = after.events()[0];
    if (snapshot?.kind !== "snapshot") throw new Error("no snapshot");
    expect(snapshot.rows.map((row) => (row.message as { role: string }).role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "compactionSummary",
    ]);
  } finally {
    await bed.dispose();
  }
});
