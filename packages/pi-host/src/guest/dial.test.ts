import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_VM_MAX_FRAME_BYTES,
  AGENT_VM_PROTOCOL,
  createFrameDecoder,
  parseBoxKey,
} from "@pap/contracts/pi-host";
import { fakeClock, IDENTITY, SLOT, TOKEN } from "../testing/guest-harness.ts";
import { dialSide, SIDE_CONNECT_MS, sideHello } from "./dial.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

async function gateway() {
  const hellos: unknown[] = [];
  const server = net.createServer((socket) => {
    const decoder = createFrameDecoder({
      maxBytes: () => AGENT_VM_MAX_FRAME_BYTES,
      onFrame: (frame) => void hellos.push(frame),
      onError: () => undefined,
    });
    socket.on("data", (chunk) => decoder.push(chunk));
    socket.on("error", () => undefined);
    cleanups.push(() => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => void server.close());
  return { port: (server.address() as net.AddressInfo).port, hellos };
}

describe("dialSide", () => {
  for (const role of ["terminal", "tunnel"] as const)
    it(`says a ${role} hello with the protocol, the box, the launch and the slot`, async () => {
      const g = await gateway();
      const clock = fakeClock();
      const socket = await dialSide(
        {
          env: { ...IDENTITY, PAP_GATEWAY: `127.0.0.1:${g.port}` },
          token: TOKEN,
          clock,
          connect: () => net.connect(g.port, "127.0.0.1"),
        },
        { role, slot: SLOT },
      );
      cleanups.push(() => socket.destroy());
      await vi.waitFor(() => expect(g.hellos).toHaveLength(1));
      expect(g.hellos[0]).toEqual({
        type: "hello",
        role,
        box: parseBoxKey(IDENTITY.PAP_BOX),
        launchId: IDENTITY.PAP_LAUNCH_ID,
        token: TOKEN,
        protocol: AGENT_VM_PROTOCOL,
        imageTag: IDENTITY.PAP_IMAGE_TAG,
        slot: SLOT,
      });
      expect(clock.pending()).toBe(0);
    });

  it("rejects a slot or an identity that does not parse, without connecting", async () => {
    let connects = 0;
    const deps = {
      env: { ...IDENTITY },
      token: TOKEN,
      clock: fakeClock(),
      connect: () => {
        connects++;
        return new net.Socket();
      },
    };
    await expect(dialSide(deps, { role: "tunnel", slot: "not-a-slot" })).rejects.toThrow("invalid");
    await expect(
      dialSide({ ...deps, env: { ...IDENTITY, PAP_GATEWAY: undefined } }, { role: "tunnel", slot: SLOT }),
    ).rejects.toThrow("invalid");
    expect(
      sideHello(
        { env: { ...IDENTITY, PAP_BOX: "nonsense" }, token: TOKEN },
        { role: "terminal", slot: SLOT },
      ),
    ).toBeNull();
    expect(connects).toBe(0);
  });

  it("gives up on a connection that has not connected after 10 s, and on one that fails", async () => {
    const clock = fakeClock();
    const stuck = new net.Socket();
    const waiting = dialSide(
      { env: { ...IDENTITY }, token: TOKEN, clock, connect: () => stuck },
      { role: "tunnel", slot: SLOT },
    );
    const outcome = expect(waiting).rejects.toThrow("timed out");
    clock.advance(SIDE_CONNECT_MS);
    await outcome;
    expect(stuck.destroyed).toBe(true);

    const closed = await new Promise<number>((resolve) => {
      const probe = net.createServer();
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as net.AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    const refused = net.connect(closed, "127.0.0.1");
    await expect(
      dialSide(
        { env: { ...IDENTITY }, token: TOKEN, clock: fakeClock(), connect: () => refused },
        { role: "tunnel", slot: SLOT },
      ),
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("keeps an error listener on the dialled socket so an error before the consumer attaches is not uncaught", async () => {
    const g = await gateway();
    const logs: string[] = [];
    const socket = await dialSide(
      {
        env: { ...IDENTITY },
        token: TOKEN,
        clock: fakeClock(),
        connect: () => net.connect(g.port, "127.0.0.1"),
        log: (line) => void logs.push(line),
      },
      { role: "tunnel", slot: SLOT },
    );
    cleanups.push(() => socket.destroy());
    expect(() => socket.emit("error", new Error("ECONNRESET"))).not.toThrow();
    expect(logs).toEqual(["side connection error: Error"]);
  });
});
