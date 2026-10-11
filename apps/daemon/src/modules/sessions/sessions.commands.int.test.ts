import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
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

// A run an extension starts is invisible to the daemon until Pi's `agent_start` reaches it, and here the extension's
// own `agent_start` hook holds the run: only pi-host's `isIdle` check can refuse (WORKER_BUSY -> session_busy).
const KICK = `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export default function (pi) {
  pi.registerCommand("kick", { handler: async () => { void pi.sendUserMessage("kicked"); } });
  pi.on("agent_start", async () => {
    writeFileSync(join(process.cwd(), "marker"), "1");
    while (!existsSync(join(process.cwd(), "release"))) await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
`;

it(
  "refuses compact and navigate while a run an extension started is held by its own hook",
  { timeout: 30_000 },
  async () => {
    const bed = await createIntBed({ steps: [{ text: "ok" }] }, { extensions: { kick: KICK } });
    try {
      const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
      const sub = await bed.subscribe(sessionId);
      expect(await bed.rpc["sessions.prompt"]({ sessionId, text: "/kick" }, bed.ctx)).toEqual({
        disposition: "handled",
      });
      await vi.waitFor(() => expect(existsSync(join(bed.work, "marker"))).toBe(true), { timeout: 10_000 });
      await expect(bed.rpc["sessions.compact"]({ sessionId }, bed.ctx)).rejects.toMatchObject({
        code: "session_busy",
      });
      await expect(
        bed.rpc["sessions.navigate"]({ sessionId, targetId: "anything" }, bed.ctx),
      ).rejects.toMatchObject({ code: "session_busy" });
      writeFileSync(join(bed.work, "release"), "1");
      await sub.waitFor(
        (event) =>
          event.kind === "pi" && event.event.type === "agent_settled" && event.event.aborted === false,
      );
    } finally {
      await bed.dispose();
    }
  },
);

it("renames and auto-names a session, and lists the name", async () => {
  const bed = await createIntBed({
    steps: [{ text: "Looking at the form." }, { text: "Fix the login bug" }],
  });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    await promptAndSettle(bed, sub, sessionId, "the login button does nothing");
    expect(await bed.rpc["sessions.autoName"]({ sessionId }, bed.ctx)).toEqual({ name: "Fix the login bug" });
    await bed.rpc["sessions.rename"]({ sessionId, name: "Login fix" }, bed.ctx);
    await sub.waitFor((event) => event.kind === "name" && event.name === "Login fix");
    expect((await bed.rpc["sessions.list"]({}, bed.ctx)).sessions[0]?.name).toBe("Login fix");
  } finally {
    await bed.dispose();
  }
});
