import { FRAME_OPS, type TerminalStreamEvent } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attach,
  createTerminal,
  newRequestId,
  rpc,
  startWire,
  untilText,
  type Wire,
} from "./testing/wire.ts";

let wire: Wire | undefined;
afterEach(async () => {
  wire?.client.close();
  await wire?.t.stop();
  wire = undefined;
});

const events = (w: Wire): TerminalStreamEvent[] =>
  w.client.events.map((frame) => frame.event as TerminalStreamEvent);

describe("terminals over the socket", () => {
  it("lists, types, resizes, exits and closes a real shell", async () => {
    wire = await startWire();
    const { client, t } = wire;
    const sub = (await client.call("subscribe.terminal", {})) as { ok: boolean };
    expect(sub.ok).toBe(true);
    await vi.waitFor(() => expect(events(wire as Wire)[0]).toEqual({ kind: "snapshot", terminals: [] }));

    const terminalId = await createTerminal(client, t.cwd);
    await vi.waitFor(() =>
      expect(events(wire as Wire)).toContainEqual(
        expect.objectContaining({
          kind: "terminal",
          terminal: expect.objectContaining({ id: terminalId, status: "running" }),
        }),
      ),
    );

    const stream = await attach(client, terminalId);
    expect(stream.info).toMatchObject({ status: "running", cols: 80, rows: 24 });
    stream.type("echo hi-$((1+1))\r");
    await untilText(stream, "hi-2");

    await rpc(client, "terminal.resize", { terminalId, cols: 100, rows: 30 });
    stream.type("stty size\r");
    await untilText(stream, "30 100");

    stream.type("exit\r");
    const exit = await client.waitForBinary(
      (frame) => frame.op === FRAME_OPS.exit && frame.streamId === stream.streamId,
    );
    expect(JSON.parse(Buffer.from(exit.payload).toString("utf8"))).toEqual({ code: 0, signal: null });
    await vi.waitFor(() =>
      expect(events(wire as Wire)).toContainEqual(
        expect.objectContaining({
          kind: "terminal",
          terminal: expect.objectContaining({ id: terminalId, status: "exited", exitCode: 0 }),
        }),
      ),
    );

    await rpc(client, "terminal.close", { terminalId });
    await vi.waitFor(() => expect(events(wire as Wire)).toContainEqual({ kind: "closed", id: terminalId }));
  });

  it("refuses a working folder outside the project roots", async () => {
    wire = await startWire();
    const reply = (await wire.client.call("terminal.create", {
      requestId: newRequestId(),
      cwd: wire.t.home,
      cols: 80,
      rows: 24,
    })) as { ok: boolean; error?: { code: string } };
    expect(reply).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("a repeat of the same request id returns the same terminal", async () => {
    wire = await startWire();
    const requestId = newRequestId();
    const first = await createTerminal(wire.client, wire.t.cwd, requestId);
    expect(await createTerminal(wire.client, wire.t.cwd, requestId)).toBe(first);
  });

  it("leaks no stream across reconnects: nine attach-and-close rounds leave the eight places free", async () => {
    wire = await startWire();
    const terminalId = await createTerminal(wire.client, wire.t.cwd);
    for (let round = 0; round < 9; round++) {
      const client = await wire.t.connect(wire.cookie);
      await attach(client, terminalId);
      client.close();
      await client.closed;
    }
    const last = await wire.t.connect(wire.cookie);
    // The server notices each close on its own time; a leaked stream would never clear.
    await vi.waitFor(async () => void (await rpc(last, "terminal.attach", { terminalId })), {
      timeout: 15_000,
      interval: 20,
    });
    last.close();
  });

  it("a connection that closes loses its streams, not the shell", async () => {
    wire = await startWire();
    const terminalId = await createTerminal(wire.client, wire.t.cwd);
    await attach(wire.client, terminalId);
    wire.client.close();
    const again = await wire.t.connect(wire.cookie);
    const stream = await attach(again, terminalId);
    expect(stream.info.status).toBe("running");
    again.close();
  });
});
