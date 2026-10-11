import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { connectTestClient } from "./ws-client.ts";

let server: WebSocketServer;
afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("test client", () => {
  it("fails a call that gets no response instead of waiting for ever", async () => {
    server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    server.on("connection", (socket) => socket.send(JSON.stringify({ protocol: 1, capabilities: [] })));
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as { port: number };
    const client = await connectTestClient(`ws://127.0.0.1:${port}`, {});
    await expect(client.call("system.ping", {}, 50)).rejects.toThrow(
      "no response to system.ping within 50 ms",
    );
    client.close();
  });
});
