import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { KEY, asAgent, bed, chat, raw, send } from "../testing/relay-bed.ts";
import { HEADERS_TIMEOUT_MS, MAX_CONNECTIONS_PER_ADDRESS, REQUEST_TIMEOUT_MS } from "./server.ts";

/*
 * Mutants (RT-43), each run for real:
 *  - M-conn-cap: no per-address connection limit -> "closes the 33rd connection" fails.
 *  - M-timeouts: leave Node's default request/headers timeouts -> "sets its own timeouts" fails.
 *  - M-recheck: no second `grantOf` after the body -> "does not serve a key revoked while its body arrived" fails.
 *  - M-reset-log: log an ECONNRESET as a refusal -> "does not log a client reset" fails.
 *  - M-answer-list: (server.test.ts) forward every upstream header -> "lets only an allow-list..." fails.
 *  - M-tls: (relay.int.test.ts) drop `rejectUnauthorized: true` -> the inherited-environment case fails.
 */
describe("the relay server: connection hygiene", () => {
  it("sets its own timeouts", async () => {
    const { server } = await bed();
    expect(server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
    expect(server.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
  });

  it(`closes the connection over ${MAX_CONNECTIONS_PER_ADDRESS} from one address (M-conn-cap)`, async () => {
    const { port, logs } = await bed();
    const held: net.Socket[] = [];
    for (let i = 0; i < MAX_CONNECTIONS_PER_ADDRESS; i++) {
      const socket = net.connect(port, "127.0.0.1");
      socket.on("error", () => {});
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      held.push(socket);
    }
    const extra = net.connect(port, "127.0.0.1");
    extra.on("error", () => {});
    await new Promise<void>((resolve) => extra.once("close", () => resolve()));
    expect(logs).toContain(`agent_relay_refused ${JSON.stringify({ agentId: null, reason: "busy" })}`);
    // A slot comes back when a held connection goes.
    held.pop()?.destroy();
    await vi.waitFor(
      async () => {
        expect(
          (await send(port, { path: "/zai/chat/completions", headers: asAgent, body: chat() })).status,
        ).toBe(200);
      },
      { timeout: 5000 },
    );
    for (const socket of held) socket.destroy();
  });
});

describe("the relay server: a key revoked while its body arrives", () => {
  it("is not served (M-recheck)", async () => {
    const { port, keys, seen, resolveProvider } = await bed();
    const checks = vi.spyOn(keys, "grantOf");
    const body = chat();
    const socket = net.connect(port, "127.0.0.1");
    socket.on("error", () => {});
    const answered = new Promise<string>((resolve) => {
      let text = "";
      socket.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        if (text.includes("\r\n\r\n")) resolve(text);
      });
      socket.on("close", () => resolve(text));
    });
    socket.write(
      `POST /zai/chat/completions HTTP/1.1\r\nHost: llm.internal:7842\r\nAuthorization: Bearer ${KEY}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, 5)}`,
    );
    await vi.waitFor(() => expect(checks).toHaveBeenCalledTimes(1), { timeout: 5000 });
    // A rotation (a new key for the same launch) leaves the request open; a revoke would end it (server.revoke.test.ts).
    keys.add({
      launchId: "a".repeat(32),
      agentId: "scout-0001",
      key: Buffer.from("cd".repeat(32), "hex"),
      address: "127.0.0.1",
    });
    socket.write(body.slice(5));
    expect(await answered).toMatch(/^HTTP\/1\.1 403 /);
    expect(resolveProvider).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
});

describe("the relay server: client errors", () => {
  const fakeSocket = () => ({ writable: true, destroy: vi.fn(), end: vi.fn() });

  it("does not log a client reset as a refusal (M-reset-log)", async () => {
    const { server, logs } = await bed();
    const socket = fakeSocket();
    server.emit("clientError", Object.assign(new Error("reset"), { code: "ECONNRESET" }), socket);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(socket.end).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it("answers 400 and logs one refusal for a malformed request", async () => {
    const { server, logs } = await bed();
    const socket = fakeSocket();
    server.emit("clientError", Object.assign(new Error("bad"), { code: "HPE_INVALID_METHOD" }), socket);
    expect(socket.end).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([`agent_relay_refused ${JSON.stringify({ agentId: null, reason: "request" })}`]);
  });
});

describe("the relay server: duplicate credential headers", () => {
  it("refuses two Authorization headers and two x-api-key headers", async () => {
    const { port, resolveProvider, seen } = await bed();
    const head = "POST /zai/chat/completions HTTP/1.1\r\nHost: llm.internal:7842\r\n";
    const tail = "Content-Length: 2\r\n\r\n{}";
    for (const credentials of [
      `Authorization: Bearer ${KEY}\r\nAuthorization: Bearer ${KEY}\r\n`,
      `x-api-key: ${KEY}\r\nx-api-key: ${KEY}\r\n`,
      `x-goog-api-key: ${KEY}\r\nx-goog-api-key: ${KEY}\r\n`,
    ])
      expect(await raw(port, head + credentials + tail), credentials).toMatch(/^HTTP\/1\.1 400 /);
    expect(resolveProvider).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
});
