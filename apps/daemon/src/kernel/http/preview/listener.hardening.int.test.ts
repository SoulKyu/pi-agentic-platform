import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createFakeClock } from "../../clock.ts";
import { PREVIEW_LIMITS } from "./limits.ts";
import {
  ARTIFACT_TOKEN,
  holdOpen,
  type PreviewBed,
  rawExchange,
  SERVICE_TOKEN,
  seenAt,
  send,
  serviceGrant,
  startPreview,
  startUpstream,
  type Upstream,
} from "./listener-bed.ts";

const P = `/p/${SERVICE_TOKEN}`;
const A = `/a/${ARTIFACT_TOKEN}`;
const UPGRADE = "Host: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n";
const held: Socket[] = [];
let upstream: Upstream;
let bed: PreviewBed;
afterEach(async () => {
  for (const socket of held.splice(0)) socket.destroy();
  await bed.close();
  await upstream.close();
});

async function start(
  options: { clock?: ReturnType<typeof createFakeClock>; onTraffic?: (box: string) => void } = {},
) {
  upstream = await startUpstream();
  bed = await startPreview({
    ...options,
    grants: {
      [SERVICE_TOKEN]: serviceGrant(upstream),
      [ARTIFACT_TOKEN]: { kind: "artifact", html: "<p>hi</p>" },
    },
  });
}
const closes = (): Promise<string> => bed.close().then(() => "closed");

describe("a refused upgrade does not hold its socket", () => {
  it("is destroyed after the 404 though the client never ends its side, and close() resolves", async () => {
    await start();
    const { reply, socket } = await holdOpen(bed.port, `GET / HTTP/1.1\r\n${UPGRADE}\r\n`);
    held.push(socket);
    expect(reply).toContain("HTTP/1.1 404");
    expect(await closes()).toBe("closed");
  }, 10_000);

  it("is destroyed after the 502 of a service that answers an upgrade with 200", async () => {
    await start();
    upstream.upgrade = (_req, socket: Duplex) => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    const { reply, socket } = await holdOpen(bed.port, `GET ${P}/ws HTTP/1.1\r\n${UPGRADE}\r\n`);
    held.push(socket);
    expect(reply).toContain("HTTP/1.1 502");
    expect(await closes()).toBe("closed");
  }, 10_000);

  it("holding 32 such clients half-open does not keep their box places: the next request is served", async () => {
    await start();
    upstream.upgrade = (_req, socket: Duplex) => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    for (let at = 0; at < PREVIEW_LIMITS.tunnelsPerBox; at++) {
      const { reply, socket } = await holdOpen(bed.port, `GET ${P}/ws HTTP/1.1\r\n${UPGRADE}\r\n`);
      held.push(socket);
      expect(reply).toContain("HTTP/1.1 502");
    }
    await vi.waitFor(async () => expect((await send(bed.port, `${P}/`)).status).toBe(200));
  }, 20_000);
});

describe("a request Node would answer itself", () => {
  it("an Expect other than 100-continue is answered 417 and the connection ends, though a body is still owed", async () => {
    await start();
    const { reply, socket } = await holdOpen(
      bed.port,
      "POST / HTTP/1.1\r\nHost: x\r\nExpect: foo\r\nContent-Length: 1000\r\n\r\nx",
    );
    held.push(socket);
    expect(reply).toContain("HTTP/1.1 417");
    // Node's own 417 keeps the connection alive, and a trickled body would keep it open for good.
    expect(reply.toLowerCase()).toContain("connection: close");
    await new Promise((resolve) => socket.once("end", resolve));
  }, 10_000);
});

describe("a body still owed when the answer is given", () => {
  it("a preflight the listener answers itself ends the connection", async () => {
    await start();
    upstream.early = true;
    upstream.answer = (_req, res) => res.writeHead(404).end();
    const { reply, socket } = await holdOpen(
      bed.port,
      `OPTIONS ${P}/x HTTP/1.1\r\nHost: x\r\nAccess-Control-Request-Method: PUT\r\nContent-Length: 100\r\n\r\nx`,
    );
    held.push(socket);
    expect(reply).toContain("HTTP/1.1 204");
    expect(reply.toLowerCase()).toContain("connection: close");
  });
});

describe("the body of a relayed request is always framed", () => {
  const request = (method: string, head: string, body: string) =>
    rawExchange(bed.port, `${method} ${P}/x HTTP/1.1\r\nHost: x\r\n${head}\r\n${body}`, (reply) =>
      reply.includes("\r\nok"),
    );

  it("a chunked DELETE and a chunked OPTIONS reach the service as exactly one framed request each", async () => {
    await start();
    for (const method of ["DELETE", "OPTIONS"]) {
      const reply = await request(
        method,
        "Transfer-Encoding: chunked\r\nConnection: close\r\n",
        "5\r\nhello\r\n0\r\n\r\n",
      );
      expect(reply).toContain("HTTP/1.1 200");
      expect(reply).toContain("\r\nok\r\n");
    }
    expect(
      upstream.seen.map((seen) => [seen.method, seen.body.toString(), seen.headers["transfer-encoding"]]),
    ).toEqual([
      ["DELETE", "hello", "chunked"],
      ["OPTIONS", "hello", "chunked"],
    ]);
  });

  it("a Connection list naming content-length does not unframe the body: nothing is smuggled", async () => {
    await start();
    const smuggled = "GET /smuggled HTTP/1.1\r\nHost: x\r\n\r\n";
    const reply = await request(
      "DELETE",
      `Connection: keep-alive, content-length\r\nContent-Length: ${smuggled.length}\r\n`,
      smuggled,
    );
    expect(reply).toContain("HTTP/1.1 200");
    expect(upstream.seen.length).toBe(1);
    expect(seenAt(upstream, 0).url).toBe("/x");
    expect(seenAt(upstream, 0).body.toString()).toBe(smuggled);
    expect(seenAt(upstream, 0).headers["content-length"]).toBe(String(smuggled.length));
  });

  it("a GET with a chunked body gets an answer", async () => {
    await start();
    const reply = await request(
      "GET",
      "Transfer-Encoding: chunked\r\nConnection: close\r\n",
      "3\r\nabc\r\n0\r\n\r\n",
    );
    expect(reply).toContain("HTTP/1.1 200");
    expect(seenAt(upstream, 0).body.toString()).toBe("abc");
  });
});

describe("an answer given before the body is read ends the connection", () => {
  it.each([
    ["an artifact", `${A}/`],
    ["a redirect", `${P}`],
  ])(
    "%s answered with a body still owed closes after the answer",
    async (_name, path) => {
      await start();
      const { reply, socket } = await holdOpen(
        bed.port,
        `GET ${path} HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nx`,
      );
      held.push(socket);
      expect(reply.toLowerCase()).toContain("connection: close");
      expect(await closes()).toBe("closed");
    },
    10_000,
  );

  it("a service that answers before the body is read ends the connection after its answer", async () => {
    await start();
    upstream.early = true;
    const { reply, socket } = await holdOpen(
      bed.port,
      `POST ${P}/x HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nx`,
    );
    held.push(socket);
    expect(reply).toContain("HTTP/1.1 200");
    expect(reply.toLowerCase()).toContain("connection: close");
  });

  it("keeps the connection of an ordinary request", async () => {
    await start();
    const { reply, socket } = await holdOpen(bed.port, `GET ${A}/ HTTP/1.1\r\nHost: x\r\n\r\n`);
    held.push(socket);
    expect(reply.toLowerCase()).not.toContain("connection: close");
  });
});

describe("the listener's socket bounds", () => {
  it("holds 256 sockets at most: the 257th is dropped, and a place freed is taken again", async () => {
    await start();
    const sockets: Socket[] = [];
    for (let at = 0; at < PREVIEW_LIMITS.listenerSockets; at++) {
      const { socket } = await holdOpen(bed.port, `GET ${A}/ HTTP/1.1\r\nHost: x\r\n\r\n`);
      sockets.push(socket);
      held.push(socket);
    }
    const dropped = await new Promise<string>((resolve) => {
      const extra = connect(bed.port, "127.0.0.1", () =>
        extra.write(`GET ${A}/ HTTP/1.1\r\nHost: x\r\n\r\n`),
      );
      extra.on("data", () => resolve("served"));
      extra.on("close", () => resolve("dropped"));
      extra.on("error", () => resolve("dropped"));
    });
    expect(dropped).toBe("dropped");
    sockets[0]?.destroy();
    await vi.waitFor(async () => expect((await send(bed.port, `${A}/`)).status).toBe(200));
  }, 30_000);

  it("cuts a client that never finishes its request headers (10 s)", async () => {
    await start();
    const closedBy = await new Promise<string>((resolve) => {
      const socket = connect(bed.port, "127.0.0.1", () => socket.write("GET / HTTP/1.1\r\nHost: x\r\n"));
      held.push(socket);
      socket.on("close", () => resolve("server"));
    });
    expect(closedBy).toBe("server");
  }, 30_000);
});

describe("activity", () => {
  it("a WebSocket page keeps its box alive: traffic after the first 10 s touches it again", async () => {
    const clock = createFakeClock();
    const touched: string[] = [];
    await start({ clock, onTraffic: (box) => touched.push(box) });
    const socket = new WebSocket(`ws://127.0.0.1:${bed.port}${P}/ws`);
    const echo = (text: string) =>
      new Promise<string>((resolve) => {
        socket.once("message", (data) => resolve(String(data)));
        socket.send(text);
      });
    await new Promise((resolve) => socket.once("open", resolve));
    expect(await echo("a")).toBe("a");
    const first = touched.length;
    expect(first).toBe(1);
    await clock.advance(10_000);
    expect(await echo("b")).toBe("b");
    expect(touched.length).toBe(first + 1);
    socket.close();
  });
});
