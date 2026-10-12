import { expect, it, vi } from "vitest";
import { createIntBed, type IntBed, promptAndSettle } from "./testing/int-bed.ts";

interface Row {
  entryId: string | null;
  message: { role: string; content: unknown };
}
const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : (content as Array<{ type: string; text?: string }>).map((block) => block.text ?? "").join("");

/** The rows a client opening the session now is given: `role:text`, and the entry ids. */
async function rowsOf(bed: IntBed, sessionId: string) {
  const first = (await bed.subscribe(sessionId)).events()[0];
  if (first?.kind !== "snapshot") throw new Error("no snapshot");
  const rows = first.rows as Row[];
  return {
    ids: rows.map((row) => row.entryId),
    texts: rows.map((row) => `${row.message.role}:${textOf(row.message.content)}`),
  };
}

/** The entries come from Pi's file, which a worker appends to a moment after the run settles. */
const eventually = (bed: IntBed, sessionId: string, expected: string[]) =>
  vi.waitFor(async () => expect((await rowsOf(bed, sessionId)).texts).toEqual(expected), { timeout: 20_000 });

it("forks and clones through the real SDK, then runs the fork on its own file", async () => {
  const bed = await createIntBed({ steps: [{ text: "r0" }, { text: "r1" }, { text: "r2" }] });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const live = await bed.subscribe(sessionId);
    await promptAndSettle(bed, live, sessionId, "q0");
    await promptAndSettle(bed, live, sessionId, "q1");
    const source = await vi.waitFor(
      async () => {
        const rows = await rowsOf(bed, sessionId);
        if (rows.texts.length !== 4) throw new Error("not yet");
        return rows;
      },
      { timeout: 20_000 },
    );
    expect(source.texts).toEqual(["user:q0", "assistant:r0", "user:q1", "assistant:r1"]);
    const second = source.ids[2];
    if (!second) throw new Error("no entry id");

    const forked = await bed.rpc["sessions.fork"]({ sessionId, entryId: second }, bed.ctx);
    expect(forked.text).toBe("q1");
    const listed = (await bed.rpc["sessions.list"]({}, bed.ctx)).sessions;
    expect(listed.find((s) => s.id === forked.sessionId)).toMatchObject({ status: "cold", cwd: bed.work });
    expect((await rowsOf(bed, forked.sessionId)).texts).toEqual(["user:q0", "assistant:r0"]);

    // The fork's worker starts on the forked file and carries on from it (the new scripted model starts at its first step).
    const forkLive = await bed.subscribe(forked.sessionId);
    await promptAndSettle(bed, forkLive, forked.sessionId, "q2");
    await eventually(bed, forked.sessionId, ["user:q0", "assistant:r0", "user:q2", "assistant:r0"]);
    expect((await rowsOf(bed, sessionId)).texts).toEqual(source.texts);

    const cloned = await bed.rpc["sessions.clone"]({ sessionId }, bed.ctx);
    const after = (await bed.rpc["sessions.list"]({}, bed.ctx)).sessions;
    expect(after.find((s) => s.id === cloned.sessionId)?.status).toBe("cold");
    expect((await rowsOf(bed, cloned.sessionId)).texts).toEqual(source.texts);
  } finally {
    await bed.dispose();
  }
}, 60_000);
