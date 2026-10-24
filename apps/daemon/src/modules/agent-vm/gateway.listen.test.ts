import { connect, type Socket } from "node:net";
import { AGENT_VM_PROTOCOL, createFrameDecoder, encodeSocketFrame, HELLO_MAX_BYTES } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import {
  createGateway,
  createLaunchTokens,
  type Gateway,
  type GuestLink,
  type LaunchTokens,
  type MirrorPort,
  type VmWorkerHandle,
  type WorkerSpawnInput,
} from "./index.ts";

let gateway: Gateway | undefined;
const sockets: Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await gateway?.close();
});

const dial = async (port: number): Promise<{ socket: Socket; frames: Promise<unknown> }> => {
  const socket = connect(port, "127.0.0.1");
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));
  const frames = new Promise<unknown>((resolve) => {
    const decoder = createFrameDecoder({ maxBytes: () => 1 << 20, onFrame: resolve, onError: () => {} });
    socket.on("data", (chunk) => decoder.push(chunk));
  });
  return { socket, frames };
};

describe("the TCP listener", () => {
  it("takes a guest hello over a real socket and sends the spawn command back", async () => {
    const tokens: LaunchTokens = createLaunchTokens();
    const launch = tokens.issue({ kind: "agent", id: "reviewer-0a1b" });
    const imageTag = `pap-agent-agent-${"a".repeat(64)}`;
    gateway = createGateway({
      tokens,
      clock: createSystemClock(),
      logger: silentLogger,
      imageOf: (id) => (id === launch.launchId ? imageTag : null),
    });
    const { port } = await gateway.listen("127.0.0.1", 0);
    expect(port).toBeGreaterThan(0);
    const { socket, frames } = await dial(port);
    socket.write(
      encodeSocketFrame({
        type: "hello",
        role: "guest",
        box: { kind: "agent", id: "reviewer-0a1b" },
        launchId: launch.launchId,
        token: launch.token,
        protocol: AGENT_VM_PROTOCOL,
        imageTag,
      }),
    );
    const link: GuestLink = await gateway.awaitGuest(launch.launchId);
    const mirrorFor = (): MirrorPort | "refused" => "refused";
    const input: WorkerSpawnInput = {
      sessionFile: null,
      sessionsDir: "/s",
      mirrorFor,
      unsent: () => false,
      sent: () => {},
    };
    const spawning: Promise<VmWorkerHandle> = link.spawnWorker(input, null);
    spawning.catch(() => {});
    expect(await frames).toMatchObject({ type: "spawn", sessionFile: null, packages: null });
  });

  it("closes a connection whose first frame is over 4 KiB", async () => {
    gateway = createGateway({
      tokens: createLaunchTokens(),
      clock: createSystemClock(),
      logger: silentLogger,
      imageOf: () => null,
    });
    const { port } = await gateway.listen("127.0.0.1", 0);
    const { socket } = await dial(port);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const head = Buffer.alloc(4);
    head.writeUInt32BE(HELLO_MAX_BYTES + 1, 0);
    socket.write(head);
    await closed;
  });

  it("rejects listen on a port in use", async () => {
    const deps = {
      tokens: createLaunchTokens(),
      clock: createSystemClock(),
      logger: silentLogger,
      imageOf: () => null,
    };
    gateway = createGateway(deps);
    const { port } = await gateway.listen("127.0.0.1", 0);
    const second = createGateway(deps);
    await expect(second.listen("127.0.0.1", port)).rejects.toThrow();
    await second.close();
  });
});
