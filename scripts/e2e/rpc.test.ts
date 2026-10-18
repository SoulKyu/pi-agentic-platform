import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { rpcCall } from "./rpc.ts";

let server: WebSocketServer | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function serve(answer: (request: Record<string, unknown>) => Record<string, unknown>[]): Promise<{
  origin: string;
  seen: { cookie: string | undefined; origin: string | undefined; request: Record<string, unknown> }[];
}> {
  const seen: { cookie: string | undefined; origin: string | undefined; request: Record<string, unknown> }[] =
    [];
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const listening = new Promise<void>((resolve) => server?.once("listening", resolve));
  server.on("connection", (socket, req) => {
    socket.send(JSON.stringify({ protocol: 2 }));
    socket.on("message", (data) => {
      const request = JSON.parse(String(data)) as Record<string, unknown>;
      seen.push({ cookie: req.headers.cookie, origin: req.headers.origin, request });
      for (const frame of answer(request)) socket.send(JSON.stringify(frame));
    });
  });
  await listening;
  return { origin: `http://localhost:${(server.address() as AddressInfo).port}`, seen };
}

describe("rpcCall", () => {
  it("sends the method with a commandId and the cookie, and resolves on the matching id", async () => {
    const { origin, seen } = await serve((request) => [
      { sub: 1, event: {} },
      { id: 99, ok: true, result: "other" },
      { id: request["id"], ok: true, result: { devices: [] } },
    ]);
    await expect(rpcCall(origin, "cookie-value", "auth.devices.list", { a: 1 })).resolves.toEqual({
      devices: [],
    });
    expect(seen[0]?.cookie).toBe("pap_session=cookie-value");
    expect(seen[0]?.origin).toBe(origin);
    expect(seen[0]?.request).toMatchObject({ id: 1, method: "auth.devices.list", params: { a: 1 } });
    expect(typeof seen[0]?.request["commandId"]).toBe("string");
  });

  it("rejects with the error code the daemon answered", async () => {
    const { origin } = await serve((request) => [
      { id: request["id"], ok: false, error: { code: "forbidden" } },
    ]);
    await expect(rpcCall(origin, "c", "x.y")).rejects.toThrow(/x\.y failed: .*forbidden/);
  });

  it("rejects when the daemon never answers, and leaves no timer behind", async () => {
    const { origin } = await serve(() => []);
    await expect(rpcCall(origin, "c", "slow.method", {}, 50)).rejects.toThrow(
      /slow\.method timed out after 50 ms/,
    );
  });
});
