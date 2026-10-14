import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FRAME_OPS, type TerminalStreamEvent } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestClient } from "../../testing/ws-client.ts";
import { attach, createTerminal, rpc, startWire, untilText, type Wire } from "./testing/wire.ts";

let wire: Wire | undefined;
const extra: TestClient[] = [];
afterEach(async () => {
  for (const client of extra.splice(0)) client.close();
  wire?.client.close();
  await wire?.t.stop();
  wire = undefined;
});

const reconnect = async (w: Wire): Promise<TestClient> => {
  const client = await w.t.connect(w.cookie);
  extra.push(client);
  return client;
};

describe("a terminal survives a browser reconnect within one daemon lifetime", () => {
  it("continues at the acked offset on a new socket: no reset, no gap, the same terminal", async () => {
    wire = await startWire();
    const terminalId = await createTerminal(wire.client, wire.t.cwd);
    const a = await attach(wire.client, terminalId);
    a.type("read x; echo got:$x\r");
    await untilText(a, "got:$x\r\n");
    const acked = a.received();
    a.ack(acked);
    wire.client.close();
    await wire.client.closed;

    const client = await reconnect(wire);
    const b = await attach(client, terminalId, acked);
    expect(b.info.status).toBe("running");
    expect(b.info.start).toBeLessThanOrEqual(acked);
    expect(acked).toBeLessThanOrEqual(b.info.end);
    b.type("hello\r");
    await untilText(b, "got:hello");
    const first = b.frames()[0];
    expect([first?.op, first?.seq]).toEqual([FRAME_OPS.output, acked]);
    expect(b.frames().some((frame) => frame.op === FRAME_OPS.reset)).toBe(false);

    await client.call("subscribe.terminal", {});
    const listed = await client.waitForEvent(
      (frame) => (frame.event as TerminalStreamEvent).kind === "snapshot",
    );
    expect(listed.event).toMatchObject({ terminals: [{ id: terminalId, status: "running" }] });
  });

  it("holds the output produced while nobody is attached, once and in place", async () => {
    wire = await startWire();
    const fifo = join(wire.t.cwd, "f");
    const done = join(wire.t.cwd, "done");
    execFileSync("mkfifo", [fifo]);
    const terminalId = await createTerminal(wire.client, wire.t.cwd);
    const a = await attach(wire.client, terminalId);
    a.type("read _ < f; echo away-1; : > done\r");
    await untilText(a, "> done\r\n");
    const acked = a.received();
    a.ack(acked);
    wire.client.close();
    await wire.client.closed;

    await writeFile(fifo, "go\n");
    await vi.waitFor(() => expect(existsSync(done)).toBe(true), { timeout: 15_000, interval: 20 });

    const client = await reconnect(wire);
    let b = await attach(client, terminalId, acked);
    await vi.waitFor(
      async () => {
        if (b.info.end > acked) return;
        await rpc(client, "terminal.detach", { streamId: b.streamId });
        b = await attach(client, terminalId, acked);
        expect(b.info.end).toBeGreaterThan(acked);
      },
      { timeout: 15_000, interval: 20 },
    );
    await untilText(b, "away-1");
    const first = b.frames()[0];
    expect([first?.op, first?.seq]).toEqual([FRAME_OPS.output, acked]);
    expect(b.text().split("away-1")).toHaveLength(2);
  });

  it("starts with a reset when `after` is past the end", async () => {
    wire = await startWire();
    const terminalId = await createTerminal(wire.client, wire.t.cwd);
    const a = await attach(wire.client, terminalId);
    a.type("echo seen\r");
    await untilText(a, "seen\r\n");
    const client = await reconnect(wire);
    // Past the end however much the shell still prints (the command's own output and prompt follow its echo).
    const b = await attach(client, terminalId, Number.MAX_SAFE_INTEGER);
    await vi.waitFor(() => expect(b.frames().length).toBeGreaterThan(0), { timeout: 15_000 });
    expect(b.frames()[0]?.op).toBe(FRAME_OPS.reset);
  });

  it("a shell that exited: attach answers exited, then the ring, then the exit frame", async () => {
    wire = await startWire();
    const terminalId = await createTerminal(wire.client, wire.t.cwd);
    const a = await attach(wire.client, terminalId);
    a.type("echo last-words\rexit 3\r");
    await wire.client.waitForBinary((frame) => frame.op === FRAME_OPS.exit && frame.streamId === a.streamId);

    const client = await reconnect(wire);
    const b = await attach(client, terminalId);
    expect(b.info.status).toBe("exited");
    await client.waitForBinary((frame) => frame.op === FRAME_OPS.exit && frame.streamId === b.streamId);
    const ops = b.frames().map((frame) => frame.op);
    expect(ops[0]).toBe(FRAME_OPS.reset);
    expect(ops.at(-1)).toBe(FRAME_OPS.exit);
    expect(b.text()).toContain("last-words");
    expect(JSON.parse(Buffer.from(b.frames().at(-1)?.payload ?? []).toString("utf8"))).toEqual({
      code: 3,
      signal: null,
    });
  });
});
