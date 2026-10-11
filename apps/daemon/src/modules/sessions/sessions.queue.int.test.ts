import { expect, it } from "vitest";
import { createIntBed } from "./testing/int-bed.ts";

const parkedBash = { toolCalls: [{ name: "bash", args: { command: "echo parked" }, id: "c1" }] };

it("delivers a steer before the next model call and a follow-up after the run, in that order", async () => {
  const bed = await createIntBed({
    steps: [parkedBash, { text: "after the steer" }, { text: "after the follow-up" }],
  });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    void bed.rpc["sessions.prompt"]({ sessionId, text: "go" }, bed.ctx);
    const ask = await sub.waitFor((event) => event.kind === "dialog_open");
    expect(
      await bed.rpc["sessions.prompt"]({ sessionId, text: "steer now", streamingBehavior: "steer" }, bed.ctx),
    ).toEqual({ disposition: "queued" });
    expect(
      await bed.rpc["sessions.prompt"](
        { sessionId, text: "then this", streamingBehavior: "followUp" },
        bed.ctx,
      ),
    ).toEqual({ disposition: "queued" });
    await sub.waitFor((event) => event.kind === "queue" && event.queue.count === 2);
    if (ask.kind !== "dialog_open") throw new Error("no dialog");
    await bed.rpc["sessions.respondDialog"](
      { sessionId, dialogId: ask.dialog.id, response: { answer: "once" } },
      bed.ctx,
    );
    await sub.waitFor((event) => event.kind === "queue" && event.queue.count === 0);
    await sub.waitFor((event) => event.kind === "status" && event.status === "idle");
    const after = await bed.subscribe(sessionId);
    const snapshot = after.events()[0];
    if (snapshot?.kind !== "snapshot") throw new Error("no snapshot");
    const said = snapshot.rows
      .map((row) => row.message as { role: string; content: unknown })
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => `${message.role}:${JSON.stringify(message.content).slice(0, 40)}`);
    expect(said.map((line) => line.split(":")[0])).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(said[2]).toContain("steer now");
    expect(said[3]).toContain("after the steer");
    expect(said[4]).toContain("then this");
    expect(snapshot.queue).toEqual({ steering: [], followUp: [], count: 0, bytes: 0 });
  } finally {
    await bed.dispose();
  }
});

it("refuses the 129th queued message, and Stop = clear the queue, then abort", async () => {
  const bed = await createIntBed({ steps: [parkedBash] });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    void bed.rpc["sessions.prompt"]({ sessionId, text: "go" }, bed.ctx);
    await sub.waitFor((event) => event.kind === "dialog_open");
    for (let i = 0; i < 128; i++) {
      await bed.rpc["sessions.prompt"]({ sessionId, text: `s${i}`, streamingBehavior: "steer" }, bed.ctx);
    }
    await expect(
      bed.rpc["sessions.prompt"]({ sessionId, text: "s128", streamingBehavior: "steer" }, bed.ctx),
    ).rejects.toMatchObject({ code: "queue_full" });
    const cleared = await bed.rpc["sessions.clearQueue"]({ sessionId }, bed.ctx);
    expect(cleared.steering).toHaveLength(128);
    expect(cleared.truncated).toBe(false);
    await sub.waitFor((event) => event.kind === "queue" && event.queue.count === 0);
    await bed.rpc["sessions.abort"]({ sessionId }, bed.ctx);
    await sub.waitFor((event) => event.kind === "status" && event.status === "idle");
  } finally {
    await bed.dispose();
  }
});

it("starts a run when a prompt carries a streaming behaviour while Pi is idle", async () => {
  const bed = await createIntBed({ steps: [{ text: "hello" }] });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    expect(
      await bed.rpc["sessions.prompt"]({ sessionId, text: "hi", streamingBehavior: "steer" }, bed.ctx),
    ).toEqual({ disposition: "started" });
  } finally {
    await bed.dispose();
  }
});
