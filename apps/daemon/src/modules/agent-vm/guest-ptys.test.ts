import { PapError, PTY_FOLDER_REFUSAL, PTY_FRAME_BYTES } from "@pap/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { PROJECT, guestHello, guestOf, type Harness, harness, type Launch } from "./gateway-fixtures.ts";
import { PTY_OPEN_MS } from "./guest-ptys.ts";

let h: Harness;
let launch: Launch;
beforeEach(() => {
  h = harness();
  launch = h.launch(PROJECT);
});

const terminalHello = (slot: string, overrides: Record<string, unknown> = {}) => ({
  ...guestHello(launch),
  role: "terminal",
  slot,
  ...overrides,
});

async function openPty() {
  const guest = await guestOf(h, launch);
  const opening = guest.link.openTerminal({ cwd: "/boxes/p/project/src", cols: 100, rows: 30 });
  const settled = opening.then(
    (channel) => channel,
    (error: unknown) => error,
  );
  const command = guest.socket.frames().at(-1) as { type: string; slot: string };
  return { guest, settled, slot: command.slot, command };
}

describe("a box terminal on the gateway", () => {
  it("asks the guest with pty_open and accepts the terminal hello of that slot", async () => {
    const { settled, slot, command } = await openPty();
    expect(command).toEqual({ type: "pty_open", slot, cwd: "/boxes/p/project/src", cols: 100, rows: 30 });
    const socket = h.connect();
    socket.feed(terminalHello(slot));
    const channel = (await settled) as { send(c: unknown): boolean };
    expect(channel.send({ type: "pty_resize", cols: 90, rows: 20 })).toBe(true);
    expect(socket.frames().at(-1)).toEqual({ type: "pty_resize", cols: 90, rows: 20 });
    expect(h.refusals()).toEqual([]);
  });

  it("delivers the reports in order, those sent before the listener included", async () => {
    const { settled, slot } = await openPty();
    const socket = h.connect();
    socket.feed(terminalHello(slot));
    socket.feed({ type: "pty_output", data: Buffer.from("hi").toString("base64") });
    socket.feed({ type: "pty_exit", code: 0, signal: null });
    const channel = (await settled) as { onReport(l: (r: unknown) => void): void };
    const got: unknown[] = [];
    channel.onReport((report) => void got.push(report));
    expect(got).toEqual([
      { type: "pty_output", data: "aGk=" },
      { type: "pty_exit", code: 0, signal: null },
    ]);
  });

  it("refuses a terminal hello for a slot nobody asked", async () => {
    await guestOf(h, launch);
    const socket = h.connect();
    socket.feed(terminalHello("f".repeat(32)));
    expect(h.refusals()).toEqual([{ box: expect.anything(), reason: "slot" }]);
    expect(socket.destroyed).toBe(true);
  });

  it("refuses a second hello for the same slot", async () => {
    const { settled, slot } = await openPty();
    h.connect().feed(terminalHello(slot));
    await settled;
    const again = h.connect();
    again.feed(terminalHello(slot));
    expect(h.refusals().at(-1)).toMatchObject({ reason: expect.stringMatching(/slot|duplicate/) });
    expect(again.destroyed).toBe(true);
  });

  it("refuses a terminal hello without a guest for the launch", () => {
    const socket = h.connect();
    socket.feed(terminalHello("a".repeat(32)));
    expect(h.refusals()).toEqual([{ box: expect.anything(), reason: "slot" }]);
  });

  it("ends the channel when the terminal connection closes", async () => {
    const { settled, slot } = await openPty();
    const socket = h.connect();
    socket.feed(terminalHello(slot));
    const channel = (await settled) as { closed: Promise<void>; send(c: unknown): boolean };
    socket.hangUp();
    await channel.closed;
    expect(channel.send({ type: "pty_resize", cols: 90, rows: 20 })).toBe(false);
  });

  it("ends every terminal of the launch when the guest's connection closes", async () => {
    const { guest, settled, slot } = await openPty();
    const socket = h.connect();
    socket.feed(terminalHello(slot));
    const channel = (await settled) as { closed: Promise<void> };
    guest.socket.hangUp();
    await channel.closed;
    expect(socket.destroyed).toBe(true);
    await expect(guest.link.openTerminal({ cwd: "/boxes/p/project", cols: 80, rows: 24 })).rejects.toEqual(
      new PapError("box_stopped"),
    );
  });

  it.each([
    [`pap-guest: ${PTY_FOLDER_REFUSAL}`, "not_found"],
    ["pap-guest: terminal_unavailable", "terminal_unavailable"],
    ["pap-guest: the shell could not start", "terminal_unavailable"],
  ])("an open the guest refused (%s) fails as %s", async (tail, code) => {
    const { guest, settled, slot } = await openPty();
    guest.socket.feed({ type: "exited", slot, code: 1, signal: null, tail });
    expect(await settled).toEqual(new PapError(code as "not_found"));
  });

  it("an open the guest never answers times out, and a late hello is refused", async () => {
    const { settled, slot } = await openPty();
    await h.clock.advance(PTY_OPEN_MS);
    expect(await settled).toEqual(new PapError("timeout"));
    const late = h.connect();
    late.feed(terminalHello(slot));
    expect(late.destroyed).toBe(true);
  });

  it("drops a frame that is not a pty report, and counts it", async () => {
    const { settled, slot } = await openPty();
    const socket = h.connect();
    socket.feed(terminalHello(slot));
    const channel = (await settled) as { onReport(l: (r: unknown) => void): void };
    const got: unknown[] = [];
    channel.onReport((report) => void got.push(report));
    socket.feed({ type: "pty_output", data: "x".repeat(PTY_FRAME_BYTES * 2) });
    socket.feed({ type: "nonsense" });
    expect(got).toEqual([]);
    expect(h.lines.some((line) => line.msg === "agent_gateway_pty_dropped")).toBe(true);
  });
});
