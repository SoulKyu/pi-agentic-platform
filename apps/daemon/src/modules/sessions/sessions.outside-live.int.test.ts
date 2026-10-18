import { appendFileSync, readdirSync, readFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { type Cursor } from "@pap/contracts";
import { expect, it } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { createIntBed, type IntBed, promptAndSettle } from "./testing/int-bed.ts";

const entry = (id: string, parentId: string, message: object) =>
  `${JSON.stringify({ type: "message", id, parentId, timestamp: "2026-10-10T00:00:09.000Z", message })}\n`;

/** The system clock read `skew.ms` ahead: a test lets a long quiet period pass by moving it, never by sleeping. */
const skewedClock = (skew: { ms: number }) => ({ ...createSystemClock(), now: () => Date.now() + skew.ms });

const piFileOf = (agentDir: string): string => {
  const file = readdirSync(agentDir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(agentDir, name))[0];
  if (file === undefined) throw new Error("no Pi file");
  return file;
};

/** A second app appends a user message at `clockNow` (the file's mtime is set from the clock, then read as the scanner does). */
function appendOutside(file: string, id: string, clockNow: number): number {
  const lines = readFileSync(file, "utf8").trim().split("\n");
  const leaf = (JSON.parse(lines.at(-1) ?? "{}") as { id: string }).id;
  appendFileSync(file, entry(id, leaf, { role: "user", content: `typed in ${id}`, timestamp: 3 }));
  utimesSync(file, clockNow / 1000, clockNow / 1000);
  return statSync(file).mtimeMs;
}

/** A quiet period is simulated by moving the clock: ahead for a second app's write, behind-then-level for pap's own command. */
const QUIET_MS = 60_000;

/** What a client opening the session now is told: the snapshot's `outsideWrite`. */
async function outsideWrite(bed: IntBed, sessionId: string, after?: Cursor): Promise<boolean> {
  const sub = await bed.subscribe(sessionId, after);
  try {
    const snapshot = sub.events()[0];
    if (snapshot?.kind !== "snapshot") throw new Error(`expected a snapshot, got ${snapshot?.kind}`);
    return snapshot.outsideWrite === true;
  } finally {
    sub.close();
  }
}

it("notices a second app's append to a live session's file, once, and not pap's own writes (spec D 3, M13R13)", async () => {
  const skew = { ms: 0 };
  const clock = skewedClock(skew);
  const bed = await createIntBed({ steps: [{ text: "one" }, { text: "two" }] }, { clock });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    await promptAndSettle(bed, sub, sessionId, "hello");
    const file = piFileOf(bed.agentDir);
    const { scanPort } = bed.sessions;

    // pap's own append at settle: inside the grace of its last activity.
    scanPort.touched(sessionId, statSync(file).mtimeMs, false, false);
    expect(await outsideWrite(bed, sessionId)).toBe(false);

    // Time passes; another app appends later than the grace after the worker's last activity.
    skew.ms += QUIET_MS;
    const first = appendOutside(file, "other-1", clock.now());
    scanPort.touched(sessionId, first, false, false);
    // A cursor resume gets a fresh snapshot (no replay) that carries the notice.
    expect(await outsideWrite(bed, sessionId, sub.cursor())).toBe(true);

    // The notice lasts 2 minutes. pap's own next prompt after that adds none.
    skew.ms += 2 * QUIET_MS + 5_000;
    expect(await outsideWrite(bed, sessionId)).toBe(false);
    await promptAndSettle(bed, sub, sessionId, "again");
    scanPort.touched(sessionId, statSync(file).mtimeMs, false, false);
    expect(await outsideWrite(bed, sessionId)).toBe(false);

    // A second append from outside is a new notice.
    skew.ms += QUIET_MS;
    scanPort.touched(sessionId, appendOutside(file, "other-2", clock.now()), false, false);
    expect(await outsideWrite(bed, sessionId)).toBe(true);
  } finally {
    await bed.dispose();
  }
}, 60_000);

it.each(["rename", "set-model"] as const)(
  "raises no notice for a %s pap makes on an idle live session after a long quiet period",
  async (command) => {
    // The clock starts a minute behind the files' real mtimes and catches up after the exchange has settled: the
    // worker's last activity is then a minute older than the command, so the command's own write is later than the
    // grace after it unless the command itself counts as activity.
    const skew = { ms: -QUIET_MS };
    const clock = skewedClock(skew);
    const bed = await createIntBed({ steps: [{ text: "ok" }] }, { clock });
    try {
      const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
      const sub = await bed.subscribe(sessionId);
      await promptAndSettle(bed, sub, sessionId, "hello");
      const file = piFileOf(bed.agentDir);
      const size = statSync(file).size;

      skew.ms = 0;
      if (command === "rename") {
        await bed.rpc["sessions.rename"]({ sessionId, name: "Renamed" }, bed.ctx);
      } else {
        const { models } = await bed.rpc["sessions.models"]({ sessionId }, bed.ctx);
        const pick = models[0];
        if (!pick) throw new Error("no model to pick");
        await bed.rpc["sessions.setModel"]({ sessionId, provider: pick.provider, modelId: pick.id }, bed.ctx);
      }
      expect(statSync(file).size).toBeGreaterThan(size);
      bed.sessions.scanPort.touched(sessionId, statSync(file).mtimeMs, false, false);
      expect(await outsideWrite(bed, sessionId)).toBe(false);
    } finally {
      await bed.dispose();
    }
  },
  60_000,
);

it("does not call pap's own last append outside once the worker is released (the `own` check)", async () => {
  const bed = await createIntBed({ steps: [{ text: "one" }] }, { workerIdleMs: 1500 });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    await promptAndSettle(bed, sub, sessionId, "hello");
    await sub.waitFor((event) => event.kind === "status" && event.status === "cold", 10_000);
    const file = piFileOf(bed.agentDir);
    // The worker started after this daemon did, so `startedAt` alone does not explain the answer.
    expect(statSync(file).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
    bed.sessions.scanPort.touched(sessionId, statSync(file).mtimeMs, false, false);
    expect(await outsideWrite(bed, sessionId)).toBe(false);
  } finally {
    await bed.dispose();
  }
}, 60_000);
