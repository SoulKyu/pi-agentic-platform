import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TriggerInput } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { createHttpApp } from "../../kernel/http/app.ts";
import { startServer } from "../../kernel/http/server.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { newHookSecret } from "./hook-auth.ts";
import { mountHookRoute } from "./hooks-http.ts";
import { writeTriggerSecret } from "./trigger-secrets.ts";

const ID = "0b3c1f6e-6a1d-4c11-8d52-5d8e9a7f3b21";
let dir: string;
let port: number;
let close: () => Promise<void>;
const sockets: Socket[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pap-hooks-socket-"));
  const secret = newHookSecret();
  writeTriggerSecret(dir, ID, secret);
  const { logger } = captureLogger();
  const input = TriggerInput.parse({
    name: "Hook",
    source: { type: "webhook", auth: "secret" },
    execution: { cwd: "/tmp" },
    prompt: "p",
  });
  const server = await startServer({
    app: createHttpApp({
      allowedOrigins: new Set(["http://localhost:7777"]),
      staticRoot: null,
      logger,
      mount: (hono) =>
        mountHookRoute(hono, {
          clock: createSystemClock(),
          logger,
          readOnly: false,
          secretsDir: dir,
          find: (id) =>
            id === ID
              ? {
                  id,
                  ownerId: "u1",
                  name: "Hook",
                  enabled: true,
                  sourceType: "webhook",
                  input,
                  cwd: "/tmp",
                  projectId: null,
                  secretRotatedAt: null,
                  nextFireAt: null,
                  lastFireAt: null,
                  lastStartAt: null,
                  revision: 1,
                  createdAt: 1,
                  updatedAt: 1,
                }
              : null,
          fire: () => ({ verdict: "fired", taskId: "t1" }),
        }),
      wsProbe: (c) => c.text("no"),
    }),
    host: "127.0.0.1",
    port: 0,
    tls: null,
    onUpgrade: (_req, socket) => socket.destroy(),
    onError: () => {},
  });
  ({ port, close } = server);
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await close();
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /hooks/<id> over a socket", () => {
  it("answers a wrong secret with a declared 50 MB body at once and closes the socket, with no Origin", async () => {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect({ host: "127.0.0.1", port }, () => resolve(s));
      s.once("error", reject);
      sockets.push(s);
    });
    let received = "";
    let sent = 0;
    const closed = new Promise<void>((resolve) => {
      socket.on("data", (data: Buffer) => (received += data.toString("latin1")));
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
    });
    socket.write(
      [
        `POST /hooks/${ID} HTTP/1.1`,
        "Host: 127.0.0.1",
        "Authorization: Bearer pwh_wrong",
        `Content-Length: ${50 * 1024 * 1024}`,
        "",
        "",
      ].join("\r\n"),
    );
    const chunk = Buffer.alloc(64 * 1024, 120);
    while (!socket.destroyed && sent < 50 * 1024 * 1024) {
      if (!socket.write(chunk))
        await Promise.race([new Promise((resolve) => socket.once("drain", resolve)), closed]);
      sent += chunk.length;
    }
    await closed;
    expect(received.startsWith("HTTP/1.1 401")).toBe(true);
    expect(received.toLowerCase()).toContain("connection: close");
    expect(socket.destroyed).toBe(true);
    expect(sent).toBeLessThan(50 * 1024 * 1024);
  });
});
