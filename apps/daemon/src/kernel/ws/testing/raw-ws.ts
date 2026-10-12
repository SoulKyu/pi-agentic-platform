import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { PROTOCOL_VERSION } from "@pap/contracts";
import { createSystemClock } from "../../clock.ts";
import { silentLogger } from "../../logger.ts";
import type { Dispatch } from "../dispatcher.ts";
import { createStreamHub } from "../stream-hub.ts";
import { createWsServer } from "../ws-server.ts";

/** One masked client text frame (RFC 6455 §5.2): FIN + text opcode, 7-bit or 16-bit length, random 4-byte mask. */
export function maskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  if (payload.length > 0xffff) throw new Error("frame too large for the test helper");
  const mask = randomBytes(4);
  const head =
    payload.length < 126
      ? Buffer.from([0x81, 0x80 | payload.length])
      : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  const masked = Buffer.from(payload.map((byte, i) => byte ^ (mask[i % 4] ?? 0)));
  return Buffer.concat([head, mask, masked]);
}

/** Opens a raw socket, performs the upgrade, reads the `101` and the server's hello frame, and returns the socket. */
export async function upgradeRaw(port: number, headers: Record<string, string>): Promise<Socket> {
  const socket = connect({ host: "127.0.0.1", port });
  try {
    const extra = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(
      [
        `GET /ws?proto=${PROTOCOL_VERSION} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
        "Sec-WebSocket-Version: 13",
        ...extra,
        "",
        "",
      ].join("\r\n"),
    );
    let buffered = Buffer.alloc(0);
    const headEnd = (): number => buffered.indexOf("\r\n\r\n");
    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer): void => {
        buffered = Buffer.concat([buffered, chunk]);
        if (headEnd() < 0) return;
        socket.off("data", onData);
        resolve();
      };
      socket.on("data", onData);
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("socket closed before the upgrade answered")));
    });
    if (!buffered.subarray(0, headEnd()).toString("latin1").startsWith("HTTP/1.1 101"))
      throw new Error(`upgrade refused: ${buffered.subarray(0, 40).toString("latin1")}`);
    // Drop the hello frame (a short unmasked server frame), which may already be in the buffer or still on its way.
    const hello = (): number => {
      const at = headEnd() + 4;
      const short = buffered[at + 1];
      if (short === undefined) return -1;
      const length = short & 0x7f;
      if (length < 126) return at + 2 + length;
      return buffered.length < at + 4 ? -1 : at + 4 + buffered.readUInt16BE(at + 2);
    };
    while (hello() < 0 || buffered.length < hello()) {
      await new Promise<void>((resolve, reject) => {
        socket.once("data", (chunk: Buffer) => {
          buffered = Buffer.concat([buffered, chunk]);
          resolve();
        });
        socket.once("error", reject);
      });
    }
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

export interface WsTestServer {
  readonly port: number;
  readonly origin: string;
  readonly cookie: string;
  close(): Promise<void>;
}

/** A real ws server on a free loopback port whose dispatcher is `dispatch`; it accepts the one cookie it returns. */
export async function startWsServerForTest(options: { dispatch: Dispatch }): Promise<WsTestServer> {
  const origin = "http://localhost:7777";
  const cookie = "pap_session=raw-ws-test";
  const clock = createSystemClock();
  const ws = createWsServer({
    allowedOrigins: new Set([origin]),
    credentialOf: ({ cookie }) => (cookie ? { kind: "cookie", value: cookie } : undefined),
    authenticate: (credential) =>
      credential?.value === cookie
        ? { userId: "u1", permissions: new Set(), kind: "session", credentialId: "raw-ws", stepUpUntil: 0 }
        : null,
    dispatch: options.dispatch,
    hub: createStreamHub("raw-ws-epoch", clock),
    logger: silentLogger,
    clock,
    serverVersion: "0.0.0-test",
  });
  const http: Server = createServer();
  const sockets = new Set<Socket>();
  http.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  http.on("upgrade", (req, socket, head) => ws.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    port: address.port,
    origin,
    cookie,
    close: async () => {
      ws.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
