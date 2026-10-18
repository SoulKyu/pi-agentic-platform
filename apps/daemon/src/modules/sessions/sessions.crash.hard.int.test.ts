import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionStreamEvent } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIntBed, type IntBed, type Subscription } from "./testing/int-bed.ts";

const beds: IntBed[] = [];
afterEach(async () => {
  for (const bed of beds.splice(0)) await bed.dispose();
});

// Only the session whose folder ends in "doomed" dies; the other one runs the same extension and carries on.
const EXIT_AT_START = `export default function (pi) {
  pi.on("agent_start", (_event, ctx) => { if (ctx.cwd.endsWith("doomed")) process.exit(7); });
}
`;
const ABORT_IN_TOOL = `export default function (pi) {
  pi.on("tool_call", (_event, ctx) => { if (ctx.cwd.endsWith("doomed")) process.abort(); });
}
`;

/** A long answer: 4 000 chunks of four characters, so the other session is mid-stream when the first one dies. */
const LONG_ANSWER = Array.from({ length: 4000 }, (_, i) => String(1000 + (i % 9000))).join("");
// Step 0 parks on an approval card (no rule covers it), step 1 is the long answer: the test holds the card until the death.
const SCRIPT = {
  steps: [
    { toolCalls: [{ name: "bash", args: { command: "env echo parked" }, id: "c1" }] },
    { text: LONG_ANSWER },
  ],
};

const open = async (extensions: Record<string, string>) => {
  const bed = await createIntBed(SCRIPT, { extensions });
  beds.push(bed);
  mkdirSync(join(bed.work, "doomed"));
  for (const dir of [bed.work, join(bed.work, "doomed")]) writeFileSync(join(dir, "a.txt"), "content");
  return bed;
};

/** The text of a `text_delta` update, or undefined for any other event. */
const deltaOf = (event: SessionStreamEvent): string | undefined => {
  if (event.kind !== "pi") return undefined;
  const update = event.event as { type?: string; assistantMessageEvent?: { type?: string; delta?: string } };
  return update.type === "message_update" && update.assistantMessageEvent?.type === "text_delta"
    ? (update.assistantMessageEvent.delta ?? "")
    : undefined;
};

const streamedText = (sub: Subscription): string =>
  sub
    .events()
    .map(deltaOf)
    .filter((delta) => delta !== undefined)
    .join("");

/**
 * Two sessions. `other` is parked on an approval card, mid-run and not yet streaming; `die` kills the first session.
 * Once the death is observed, `other` must still be running with no text, and only then is its card answered, so the
 * whole stream follows the death. It must be gapless and complete.
 */
async function dieDuringStream(
  bed: IntBed,
  die: (doomed: string, doomedSub: Subscription) => Promise<void>,
): Promise<{ doomedSub: Subscription; doomed: string }> {
  const doomed = (await bed.rpc["sessions.create"]({ cwd: join(bed.work, "doomed") }, bed.ctx)).sessionId;
  const other = (await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx)).sessionId;
  const doomedSub = await bed.subscribe(doomed);
  const otherSub = await bed.subscribe(other);
  void bed.rpc["sessions.prompt"]({ sessionId: other, text: "talk" }, bed.ctx);
  const card = await otherSub.waitFor((e) => e.kind === "dialog_open");
  if (card.kind !== "dialog_open") throw new Error("no card");
  await die(doomed, doomedSub);
  const statuses = otherSub.events().flatMap((e) => (e.kind === "status" ? [e.status] : []));
  expect(statuses.at(-1)).toBe("running");
  expect(streamedText(otherSub)).toBe("");
  const atDeath = otherSub.seqs().length;
  await bed.rpc["sessions.respondDialog"](
    { sessionId: other, dialogId: card.dialog.id, response: { answer: "once" } },
    bed.ctx,
  );
  await vi.waitFor(
    () => {
      const after = otherSub.events().flatMap((e) => (e.kind === "status" ? [e.status] : []));
      if (after.at(-1) !== "idle") throw new Error("still streaming");
    },
    { timeout: 20_000 },
  );
  // Gapless: the sequence numbers count up by one from the first frame to the last, the stream went on after the death, and the text is the whole answer.
  const seqs = otherSub.seqs();
  expect(seqs.length).toBeGreaterThan(atDeath);
  expect(seqs.map((seq, i) => seq - (seqs[0] ?? 0) - i)).toEqual(seqs.map(() => 0));
  expect(streamedText(otherSub)).toBe(LONG_ANSWER);
  // The daemon answers, and lists the dead session as cold.
  expect((await bed.rpc["sessions.list"]({}, bed.ctx)).sessions.map((s) => [s.id, s.status])).toEqual(
    expect.arrayContaining([[doomed, "cold"]]),
  );
  expect(bed.exits.map((exit) => exit.sessionId)).toEqual([doomed]);
  return { doomedSub, doomed };
}

const coldCause = async (sub: Subscription): Promise<string | undefined> => {
  const cold = await sub.waitFor((e) => e.kind === "status" && e.status === "cold");
  return cold.kind === "status" ? cold.cause : undefined;
};

describe("hard worker exits (spec A success criterion 1): a second session keeps a gapless stream", () => {
  it("process.exit(7) at agent_start: the session reports a dead worker with its cause, the other stream has no gap", async () => {
    const bed = await open({ exit: EXIT_AT_START });
    const { doomedSub } = await dieDuringStream(bed, async (doomed, sub) => {
      void bed.rpc["sessions.prompt"]({ sessionId: doomed, text: "go" }, bed.ctx).catch(() => undefined);
      await sub.waitFor((e) => e.kind === "status" && e.status === "cold");
    });
    expect(await coldCause(doomedSub)).toBe("Agent process exited with code 7.");
    expect(bed.exits[0]?.exit).toMatchObject({ cause: "exit_code", code: 7 });
  });

  it("process.abort() inside a tool call: the session reports SIGABRT, the other stream has no gap", async () => {
    const bed = await open({ abort: ABORT_IN_TOOL });
    const { doomedSub } = await dieDuringStream(bed, async (doomed, sub) => {
      void bed.rpc["sessions.prompt"]({ sessionId: doomed, text: "go" }, bed.ctx).catch(() => undefined);
      await sub.waitFor((e) => e.kind === "status" && e.status === "cold");
    });
    expect(await coldCause(doomedSub)).toBe("Agent process stopped by SIGABRT.");
    expect(bed.exits[0]?.exit).toMatchObject({ cause: "signal", signal: "SIGABRT" });
  });

  // The kernel's memory kill sends this same signal; the `oom` classification itself is asserted by
  // kernel/supervisor/scope.int.test.ts and sessions.crash.oom.int.test.ts, not repeated here.
  it("kill -9 of a worker in the middle of a run, while another session is mid-run: no gap on the other stream", async () => {
    const bed = await open({});
    const { doomedSub } = await dieDuringStream(bed, async (doomed, sub) => {
      // A run in progress: the first session is parked on its own approval card when the kill lands.
      void bed.rpc["sessions.prompt"]({ sessionId: doomed, text: "go" }, bed.ctx).catch(() => undefined);
      await sub.waitFor((e) => e.kind === "dialog_open");
      bed.killWorker(doomed);
      await sub.waitFor((e) => e.kind === "status" && e.status === "cold");
    });
    expect(await coldCause(doomedSub)).toBe("Agent process killed (SIGKILL), possibly out of memory.");
    expect(bed.exits[0]?.exit).toMatchObject({ cause: "killed", signal: "SIGKILL" });
  });
});
