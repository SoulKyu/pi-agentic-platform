import net from "node:net";
import { AGENT_VM_MAX_FRAME_BYTES, createFrameDecoder, encodeSocketFrame, WorkerHello } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RECORD_BYTES } from "./ipc.ts";
import { createSocketIpc } from "./socket-ipc.ts";

const hello = WorkerHello.parse({
  type: "hello",
  role: "worker",
  box: { kind: "agent", id: "scout-ab12" },
  launchId: "a".repeat(32),
  token: "b".repeat(64),
  protocol: 2,
  imageTag: `pap-agent-agent-${"c".repeat(64)}`,
  slot: "d".repeat(32),
  session: { file: null, lastEntryId: null, size: 0 },
});

interface Pair {
  worker: net.Socket;
  daemon: net.Socket;
  received: unknown[];
}
const open: net.Socket[] = [];
const servers: net.Server[] = [];
afterEach(() => {
  for (const socket of open.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) server.close();
});

async function pair(): Promise<Pair> {
  const server = net.createServer();
  servers.push(server);
  const accepted = new Promise<net.Socket>((resolve) => server.once("connection", resolve));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  const worker = net.connect(port, "127.0.0.1");
  const daemon = await accepted;
  open.push(worker, daemon);
  const received: unknown[] = [];
  const decoder = createFrameDecoder({
    maxBytes: () => AGENT_VM_MAX_FRAME_BYTES,
    onFrame: (value) => received.push(value),
    onError: () => undefined,
  });
  daemon.on("data", (chunk) => decoder.push(chunk));
  return { worker, daemon, received };
}

const record = (extra: Record<string, unknown> = {}) => ({ type: "health", rssMb: 1, ...extra });

describe("createSocketIpc", () => {
  it("sends the hello as the first frame, then the records", async () => {
    const { worker, received } = await pair();
    const ipc = createSocketIpc(worker, hello);
    expect(ipc.send(record())).toBe(true);
    await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 5000 });
    expect(received).toEqual([hello, record()]);
  });

  it("answers a ping with a pong and never hands it to onMessage", async () => {
    const { worker, daemon, received } = await pair();
    const ipc = createSocketIpc(worker, hello);
    const heard: unknown[] = [];
    const malformed: unknown[] = [];
    ipc.onMessage(
      (message) => heard.push(message),
      (raw) => malformed.push(raw),
    );
    daemon.write(encodeSocketFrame({ type: "ping" }));
    await vi.waitFor(() => expect(received).toContainEqual({ type: "pong" }), { timeout: 5000 });
    expect(heard).toEqual([]);
    expect(malformed).toEqual([]);
  });

  it("delivers a valid daemon record and reports a malformed one without echoing it", async () => {
    const { worker, daemon } = await pair();
    const ipc = createSocketIpc(worker, hello);
    const heard: unknown[] = [];
    const malformed: unknown[] = [];
    ipc.onMessage(
      (message) => heard.push(message),
      (raw) => malformed.push(raw),
    );
    daemon.write(encodeSocketFrame({ type: "nonsense", secret: "s3cret" }));
    await vi.waitFor(() => expect(malformed).toEqual([{ type: "nonsense", secret: "s3cret" }]), {
      timeout: 5000,
    });
    expect(heard).toEqual([]);
  });

  it("closes the socket and fires onDisconnect once on a frame over the bound", async () => {
    const { worker, daemon } = await pair();
    const ipc = createSocketIpc(worker, hello);
    const gone = vi.fn();
    ipc.onDisconnect(gone);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(AGENT_VM_MAX_FRAME_BYTES + 1, 0);
    daemon.write(head);
    await vi.waitFor(() => expect(worker.destroyed).toBe(true), { timeout: 5000 });
    await vi.waitFor(() => expect(gone).toHaveBeenCalledTimes(1), { timeout: 5000 });
    daemon.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("fires onDisconnect when the daemon closes, and at once for a late listener", async () => {
    const { worker, daemon } = await pair();
    const ipc = createSocketIpc(worker, hello);
    daemon.destroy();
    await vi.waitFor(() => expect(worker.destroyed).toBe(true), { timeout: 5000 });
    const late = vi.fn();
    ipc.onDisconnect(late);
    expect(late).toHaveBeenCalledTimes(1);
    expect(ipc.send(record())).toBe(false);
  });

  it("refuses a record over MAX_RECORD_BYTES and sends the small response failure", async () => {
    const { worker, received } = await pair();
    const ipc = createSocketIpc(worker, hello);
    const big = "x".repeat(MAX_RECORD_BYTES);
    expect(ipc.send({ type: "response", id: "r1", command: "prompt", success: true, data: big })).toBe(false);
    await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 5000 });
    expect(received[1]).toEqual({
      type: "response",
      id: "r1",
      command: "prompt",
      success: false,
      error: "record too large",
    });
  });

  it("refuses a big non-response record with an extension_error", async () => {
    const { worker, received } = await pair();
    const ipc = createSocketIpc(worker, hello);
    expect(ipc.send({ type: "health", blob: "x".repeat(MAX_RECORD_BYTES) })).toBe(false);
    await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 5000 });
    expect(received[1]).toMatchObject({
      type: "extension_error",
      extensionPath: "pi-host:ipc",
      event: "health",
    });
  });
});
