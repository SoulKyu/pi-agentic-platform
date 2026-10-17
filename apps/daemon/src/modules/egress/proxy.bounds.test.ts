import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EGRESS_LIMITS } from "@pap/contracts";
import type { Limits } from "./index.ts";
import { type Bed, closed, connectLine, exchange, startBed, statusOf } from "./testing/bed.ts";

let bed: Bed;
afterEach(async () => {
  await bed.stop();
});

const small = (over: Partial<Limits>): Limits => ({ ...EGRESS_LIMITS, ...over });
const GET = "GET http://allowed.test/ HTTP/1.1\r\nHost: x\r\n\r\n";

describe("one request or CONNECT per client connection", () => {
  it("100 pipelined requests open one upstream, and none stays open after close", async () => {
    bed = await startBed({ hang: true });
    const listener = await bed.listen();
    const client = connect(listener.path);
    client.on("error", () => {});
    client.write(GET.repeat(100));
    await closed(client);
    expect(bed.calls.connect).toHaveLength(1);
    await listener.close();
    await vi.waitFor(async () => expect(await bed.originOpen()).toBe(0), { timeout: 5000 });
  });

  it("GET then CONNECT on one connection opens one upstream", async () => {
    bed = await startBed({ hang: true });
    const listener = await bed.listen();
    const client = connect(listener.path);
    client.on("error", () => {});
    client.write(GET + connectLine("allowed.test:443"));
    await closed(client);
    expect(bed.calls.connect).toHaveLength(1);
    expect(bed.calls.connect[0]?.port).toBe(80);
  });

  it("a second request after the first answer (keep-alive reuse) opens no second upstream", async () => {
    bed = await startBed();
    const listener = await bed.listen();
    const client = connect(listener.path);
    client.on("error", () => {});
    let received = "";
    client.on("data", (chunk: Buffer) => {
      received += chunk.toString();
      if (received.includes("origin ok")) client.write(GET);
    });
    client.write(GET);
    await closed(client);
    expect(bed.calls.connect).toHaveLength(1);
    expect(bed.seen).toHaveLength(1);
  });

  it("closing the command with a hanging origin leaves the origin holding no socket", async () => {
    bed = await startBed({ hang: true });
    const listener = await bed.listen();
    const client = connect(listener.path);
    client.on("error", () => {});
    client.write(GET);
    await vi.waitFor(async () => expect(await bed.originOpen()).toBe(1), { timeout: 5000 });
    await listener.close();
    await vi.waitFor(async () => expect(await bed.originOpen()).toBe(0), { timeout: 5000 });
  });
});

describe("a refused connection does not linger", () => {
  it("half-open clients past the connection cap are closed by the proxy without their help", async () => {
    bed = await startBed({ limits: small({ connections: 2 }) });
    const listener = await bed.listen();
    const held: Socket[] = [];
    for (let i = 0; i < 2; i += 1) {
      const socket = connect({ path: listener.path, allowHalfOpen: true });
      socket.on("error", () => {});
      held.push(socket);
    }
    const lingering: Socket[] = [];
    for (let i = 0; i < 20; i += 1) {
      const socket = connect({ path: listener.path, allowHalfOpen: true });
      socket.on("error", () => {});
      lingering.push(socket);
    }
    await vi.waitFor(
      () =>
        new Promise<void>((resolve, reject) =>
          listener.server.getConnections((_error, count) =>
            count === 2 ? resolve() : reject(new Error(`${count}`)),
          ),
        ),
      { timeout: 5000 },
    );
    for (const socket of [...held, ...lingering]) socket.destroy();
  });

  it("a malformed head and a refused CONNECT are closed the same way", async () => {
    bed = await startBed();
    const listener = await bed.listen();
    const open: Socket[] = [];
    for (const payload of ["GARBAGE\r\n\r\n", connectLine("evil.test:443"), connectLine("allowed.test:22")]) {
      const socket = connect({ path: listener.path, allowHalfOpen: true }, () => socket.write(payload));
      socket.on("error", () => {});
      open.push(socket);
    }
    await vi.waitFor(
      () =>
        new Promise<void>((resolve, reject) =>
          listener.server.getConnections((_error, count) =>
            count === 0 ? resolve() : reject(new Error(`${count}`)),
          ),
        ),
      { timeout: 5000 },
    );
    for (const socket of open) socket.destroy();
  });

  it("still answers the refusal before closing", async () => {
    bed = await startBed({ limits: small({ connections: 1 }) });
    const listener = await bed.listen();
    const held = connect(listener.path);
    held.on("error", () => {});
    await vi.waitFor(
      async () =>
        expect(statusOf(await exchange(listener.path, GET))).toBe("HTTP/1.1 503 Service Unavailable"),
      { timeout: 5000 },
    );
    held.destroy();
  });
});
