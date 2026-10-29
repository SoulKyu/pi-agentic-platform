import { request } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createFakeClock } from "../../clock.ts";
import {
  ARTIFACT_TOKEN,
  type PreviewBed,
  SERVICE_TOKEN,
  seenAt,
  send,
  serviceGrant,
  startPreview,
  startUpstream,
  type Upstream,
} from "./listener-bed.ts";
import { PREVIEW_LIMITS } from "./limits.ts";

const P = `/p/${SERVICE_TOKEN}`;
const MIB = 1024 * 1024;
let upstream: Upstream;
let bed: PreviewBed;
afterEach(async () => {
  await bed.close();
  await upstream.close();
});

async function start(open?: () => Promise<Duplex>, clock = createFakeClock()): Promise<void> {
  upstream = await startUpstream();
  bed = await startPreview({
    clock,
    grants: {
      [SERVICE_TOKEN]: serviceGrant(upstream, open === undefined ? {} : { open }),
      [ARTIFACT_TOKEN]: { kind: "artifact", html: "<p>hi</p>" },
    },
  });
}

describe("the untrusted listener's bounds", () => {
  it("refuses a body declared over 10 MiB with 413 before a tunnel opens", async () => {
    const open = vi.fn(() => Promise.resolve(connect(upstream.port, "127.0.0.1") as Duplex));
    await start(open);
    const declared = await send(bed.port, `${P}/up`, {
      method: "POST",
      body: Buffer.alloc(PREVIEW_LIMITS.bodyBytes + 1),
    });
    expect(declared.status).toBe(413);
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses a body streamed past 10 MiB with 413", async () => {
    await start();
    const streamed = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: bed.port, path: `${P}/up`, method: "POST", agent: false },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      for (let sent = 0; sent <= PREVIEW_LIMITS.bodyBytes; sent += MIB) req.write(Buffer.alloc(MIB));
      req.end();
    });
    expect(streamed).toBe(413);
    expect(upstream.seen).toEqual([]);
  });

  it("relays a body of exactly 10 MiB", async () => {
    await start();
    const exact = await send(bed.port, `${P}/up`, {
      method: "POST",
      body: Buffer.alloc(PREVIEW_LIMITS.bodyBytes),
    });
    expect(exact.status).toBe(200);
    expect(seenAt(upstream, -1).body.length).toBe(PREVIEW_LIMITS.bodyBytes);
  });

  it("12 parallel GETs while the guest is slow to open all succeed; with 32 already holding a place the next is 503 busy", async () => {
    const pending: (() => void)[] = [];
    const open = vi.fn(
      () =>
        new Promise<Duplex>((resolve) => {
          pending.push(() => resolve(connect(upstream.port, "127.0.0.1") as Duplex));
        }),
    );
    await start(open);
    const twelve = Array.from({ length: 12 }, () => send(bed.port, `${P}/`));
    // Two opens at a time: the others wait their turn.
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    for (let done = 0; done < 12; done++) {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
      pending.shift()?.();
    }
    expect((await Promise.all(twelve)).map((answer) => answer.status)).toEqual(Array(12).fill(200));
    expect(open).toHaveBeenCalledTimes(12);

    open.mockClear();
    const held = Array.from({ length: PREVIEW_LIMITS.tunnelsPerBox }, () => send(bed.port, `${P}/`));
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(PREVIEW_LIMITS.opensPerBox));
    const over = await send(bed.port, `${P}/`);
    expect(over.status).toBe(503);
    expect(over.headers["content-security-policy"]).toContain("sandbox");
    expect(open).toHaveBeenCalledTimes(PREVIEW_LIMITS.opensPerBox);
    expect(bed.logger.lines.some((line) => line.fields?.reason === "busy")).toBe(true);
    for (let done = 0; done < PREVIEW_LIMITS.tunnelsPerBox; done++) {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
      pending.shift()?.();
    }
    expect((await Promise.all(held)).every((answer) => answer.status === 200)).toBe(true);
  });

  it("answers 503 busy when an open waits past its 15 s, and 502 when the guest cannot open", async () => {
    const clock = createFakeClock();
    const opens: (() => void)[] = [];
    await start(() => new Promise<Duplex>(() => opens.push(() => {})), clock);
    for (let held = 0; held < 2; held++) send(bed.port, `${P}/`).catch(() => {});
    await vi.waitFor(() => expect(opens.length).toBe(2));
    let answered: number | null = null;
    send(bed.port, `${P}/`)
      .then((answer) => (answered = answer.status))
      .catch(() => {});
    // The third request reaches the queue some turns after it is sent: advance until its wait is over.
    await vi.waitFor(async () => {
      await clock.advance(PREVIEW_LIMITS.openWaitMs / 5);
      expect(answered).toBe(503);
    });
    await bed.close();
    await upstream.close();
    await start(() => Promise.reject(new Error("box stopped")));
    expect((await send(bed.port, `${P}/`)).status).toBe(502);
  });

  it("a stopped box (an open rejected with box_stopped) is a 503 box_stopped for a request and for an upgrade, not a 502", async () => {
    await start(() => Promise.reject(new PapError("box_stopped")));
    const answer = await send(bed.port, `${P}/`);
    expect(answer.status).toBe(503);
    expect(String(answer.headers["content-security-policy"])).toContain("sandbox");
    const socket = new WebSocket(`ws://127.0.0.1:${bed.port}${P}/ws`);
    const status = await new Promise<number>((resolve, reject) => {
      socket.on("unexpected-response", (_req, res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      socket.on("error", reject);
    });
    expect(status).toBe(503);
    const reasons = bed.logger.lines
      .filter((line) => line.msg === "preview_refused")
      .map((line) => line.fields?.reason);
    expect(reasons).toContain("box_stopped");
    expect(reasons).not.toContain("upstream_failed");
    // Any other failure to open stays a 502.
    await bed.close();
    await upstream.close();
    await start(() => Promise.reject(new PapError("timeout")));
    expect((await send(bed.port, `${P}/`)).status).toBe(502);
  });

  it("relays a WebSocket and drops the cookie of the handshake", async () => {
    await start();
    const socket = new WebSocket(`ws://127.0.0.1:${bed.port}${P}/ws?room=1`, {
      headers: { cookie: "pap=1", authorization: "Bearer x" },
    });
    const echoed = await new Promise<string>((resolve, reject) => {
      socket.on("open", () => socket.send("ping"));
      socket.on("message", (data) => resolve(String(data)));
      socket.on("error", reject);
    });
    expect(echoed).toBe("ping");
    const seen = seenAt(upstream, 0);
    expect(seen.url).toBe("/ws?room=1");
    expect(seen.headers["x-forwarded-prefix"]).toBe(P);
    for (const name of ["cookie", "authorization"]) expect(seen.headers).not.toHaveProperty(name);
    socket.close();
  });

  it("an upgrade the service answers with 200 and Set-Cookie gets a bare 502 and none of its headers", async () => {
    await start();
    upstream.upgrade = (_req, socket) =>
      socket.end("HTTP/1.1 200 OK\r\nSet-Cookie: sid=1\r\nX-Own: 1\r\nContent-Length: 2\r\n\r\nhi");
    const socket = new WebSocket(`ws://127.0.0.1:${bed.port}${P}/ws`);
    const answer = await new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
      (resolve, reject) => {
        socket.on("unexpected-response", (_req, res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => (body += chunk.toString()));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        });
        socket.on("error", reject);
      },
    );
    expect(answer.status).toBe(502);
    expect(answer.body).toBe("");
    expect(answer.headers["set-cookie"]).toBeUndefined();
    expect(answer.headers["x-own"]).toBeUndefined();
    expect(String(answer.headers["content-security-policy"])).toContain("sandbox");
  });

  it("refuses an upgrade to an artifact or an unknown token", async () => {
    await start();
    for (const path of [`/a/${ARTIFACT_TOKEN}/`, `/p/${"Z".repeat(43)}/ws`, `${P}`, "/"]) {
      const socket = new WebSocket(`ws://127.0.0.1:${bed.port}${path}`);
      const status = await new Promise<number>((resolve) => {
        socket.on("unexpected-response", (_req, res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        socket.on("error", () => resolve(-1));
      });
      expect(status).toBe(404);
    }
    expect(upstream.seen).toEqual([]);
  });

  it("ends a relayed connection idle for 120 s", { timeout: 10_000 }, async () => {
    const clock = createFakeClock();
    await start(undefined, clock);
    upstream.answer = () => {};
    const ended = send(bed.port, `${P}/slow`).then(
      () => "answered",
      () => "ended",
    );
    await vi.waitFor(() => expect(upstream.seen.length).toBe(1));
    await clock.advance(PREVIEW_LIMITS.idleMs - 1);
    await clock.advance(1);
    expect(await ended).toBe("ended");
    expect(bed.logger.lines.some((line) => line.fields?.reason === "idle")).toBe(true);
  });

  it("logs usage per box every 60 s and touches the box at most once per 10 s", async () => {
    const clock = createFakeClock();
    const touched: string[] = [];
    upstream = await startUpstream();
    bed = await startPreview({
      clock,
      onTraffic: (box) => touched.push(box),
      grants: { [SERVICE_TOKEN]: serviceGrant(upstream) },
    });
    await send(bed.port, `${P}/`);
    await send(bed.port, `${P}/`);
    expect(touched).toEqual(["box-1"]);
    await clock.advance(10_000);
    await send(bed.port, `${P}/`);
    expect(touched).toEqual(["box-1", "box-1"]);
    await clock.advance(50_000);
    const usage = bed.logger.lines.filter((line) => line.msg === "preview_usage");
    expect(usage.map((line) => line.fields)).toEqual([{ box: "box-1", requests: 3, bytes: 6, refusals: 0 }]);
    await clock.advance(60_000);
    expect(bed.logger.lines.filter((line) => line.msg === "preview_usage").length).toBe(1);
    expect(bed.logger.lines.filter((line) => line.msg === "preview_relay").length).toBe(3);
  });
});
