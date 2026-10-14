import { existsSync } from "node:fs";
import { join } from "node:path";
import { FRAME_OPS } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestClient } from "../../testing/ws-client.ts";
import { attach, createTerminal, startWire, untilText, type TermStream, type Wire } from "./testing/wire.ts";

let wire: Wire | undefined;
const extra: TestClient[] = [];
afterEach(async () => {
  for (const client of extra.splice(0)) client.close();
  wire?.client.close();
  await wire?.t.stop();
  wire = undefined;
});

const second = async (w: Wire): Promise<TestClient> => {
  const client = await w.t.connect(w.cookie);
  extra.push(client);
  return client;
};

const KIB = 1024;
const SIX_MB = 6_000_000;
const FLOOD = `head -c ${SIX_MB} /dev/zero | tr '\\0' 'x'`;

/** The offsets of the output frames chain: each starts where the previous one ended. */
function contiguous(stream: TermStream): boolean {
  let next: number | null = null;
  for (const frame of stream.frames()) {
    if (frame.op === FRAME_OPS.reset) next = null;
    if (frame.op !== FRAME_OPS.output) continue;
    if (next !== null && frame.seq !== next) return false;
    next = frame.seq + frame.payload.byteLength;
  }
  return true;
}

describe("several clients on one terminal", () => {
  it("both see the output, and the other keeps receiving when one goes", async () => {
    wire = await startWire();
    const terminalId = await createTerminal(wire.client, wire.t.cwd);
    const other = await second(wire);
    const a = await attach(wire.client, terminalId);
    const b = await attach(other, terminalId);
    a.type("echo both-$((2+3))\r");
    await untilText(a, "both-5");
    await untilText(b, "both-5");
    other.close();
    await other.closed;
    a.type("echo alone-$((3+4))\r");
    await untilText(a, "alone-7");
  });

  it("a client that never acks does not slow the one that does, and gets a reset when it catches up", async () => {
    wire = await startWire();
    const terminalId = await createTerminal(wire.client, wire.t.cwd);
    const quiet = await second(wire);
    const busy = await attach(wire.client, terminalId);
    const silent = await attach(quiet, terminalId);
    busy.type(`${FLOOD}; echo done-$((1+1))\r`);
    await vi.waitFor(
      () => {
        busy.ack(busy.received());
        expect(busy.frames().at(-1)?.seq).toBeGreaterThanOrEqual(SIX_MB - 64 * KIB);
        expect(busy.text()).toContain("done-2");
      },
      { timeout: 60_000, interval: 5 },
    );
    const run = /x+/g;
    const longest = Math.max(...[...busy.text().matchAll(run)].map((hit) => hit[0].length));
    expect(longest).toBe(SIX_MB);
    expect(contiguous(busy)).toBe(true);
    expect(busy.frames().filter((frame) => frame.op === FRAME_OPS.reset)).toHaveLength(1);

    const silentBytes = silent.text().length;
    expect(silentBytes).toBeLessThanOrEqual(512 * KIB + 64 * KIB);
    silent.ack(silent.received());
    await vi.waitFor(
      () => {
        const resets = silent.frames().filter((frame) => frame.op === FRAME_OPS.reset && frame.seq > 0);
        expect(resets).toHaveLength(1);
        expect(resets[0]?.seq).toBeGreaterThanOrEqual(SIX_MB - 4 * 1024 * KIB);
      },
      { timeout: 30_000, interval: 20 },
    );
  });

  it("a lone client that stops acking (a hidden tab) does not hold the shell", async () => {
    wire = await startWire();
    const terminalId = await createTerminal(wire.client, wire.t.cwd);
    const hidden = await attach(wire.client, terminalId);
    const finished = join(wire.t.cwd, "finished");
    hidden.type(`${FLOOD}; : > finished; echo done-$((1+1))\r`);
    await vi.waitFor(() => expect(existsSync(finished)).toBe(true), { timeout: 60_000, interval: 50 });
    expect(hidden.text().length).toBeLessThanOrEqual(512 * KIB + 64 * KIB);
    // Back on screen: it acks again, gets a reset at the ring's start and reads on to the end.
    await vi.waitFor(
      () => {
        hidden.ack(hidden.received());
        expect(hidden.frames().some((frame) => frame.op === FRAME_OPS.reset && frame.seq > 0)).toBe(true);
        expect(hidden.text()).toContain("done-2");
      },
      { timeout: 30_000, interval: 5 },
    );
  });
});
