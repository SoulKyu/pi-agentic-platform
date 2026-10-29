import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PROTOCOL_VERSION } from "@pap/contracts";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { captureLogger } from "./testing/capture-logger.ts";
import { freePort } from "./testing/free-port.ts";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";
import { httpRequest } from "./testing/http-client.ts";

// The untrusted preview listener on the production path (UX-2 T3): the real createDaemon, the real listener, port 0 for the app.
const started: TestDaemon[] = [];
afterEach(async () => {
  for (const daemon of started.splice(0).reverse()) await daemon.stop();
});

async function boot(previewPort?: number) {
  const { logger, lines } = captureLogger();
  const port = previewPort ?? (await freePort());
  const t = await startTestDaemon({ steps: [] }, { config: { previewPort: port }, deps: { logger } });
  started.push(t);
  return { t, port, named: (msg: string) => lines.filter((line) => line.msg === msg) };
}

/** A `ws` upgrade that is expected to be refused: the status line of the refusal. */
function refusedUpgrade(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
    });
    socket.on("open", () => {
      socket.close();
      reject(new Error("the upgrade was accepted"));
    });
    socket.on("error", () => undefined);
  });
}

describe("the preview listener of the real daemon", () => {
  it("the preview listener answers / with a bare 404 and the sandbox CSP", async () => {
    const { port } = await boot();
    const reply = await httpRequest(`http://127.0.0.1:${port}/`);
    expect(reply.status).toBe(404);
    expect(reply.body).toBe("");
    expect(String(reply.headers["content-security-policy"])).toMatch(/^sandbox /);
  });

  it("a WebSocket upgrade with an allowed Origin and Sec-Fetch-Site: same-site is refused 403 on the real daemon", async () => {
    const { t, named } = await boot();
    const cookie = await t.login();
    const url = `ws://127.0.0.1:${t.port}/ws?proto=${PROTOCOL_VERSION}`;
    // The control: the same upgrade without the header is accepted (the harness client).
    (await t.connect(cookie)).close();
    expect(await refusedUpgrade(url, { origin: t.origin, cookie, "sec-fetch-site": "same-site" })).toBe(403);
    expect(named("fetch_site_refused")).toEqual([expect.objectContaining({ via: "ws", site: "same-site" })]);
  });

  it("the app's CSP frames the preview origin only", async () => {
    const { t, port } = await boot();
    const reply = await httpRequest(`${t.base}/healthz`);
    const csp = String(reply.headers["content-security-policy"]);
    expect(csp.endsWith(`; frame-src http://localhost:${port}`)).toBe(true);
    expect(csp.match(/frame-src/g)).toHaveLength(1);
  });

  it("a same-site read of /files/raw is refused 403 and logged fetch_site_refused once", async () => {
    const { t, named } = await boot();
    const cookie = await t.login();
    const read = () =>
      httpRequest(`${t.base}/files/raw?path=%2Fetc%2Fhostname`, {
        headers: { cookie, origin: t.origin, "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors" },
      });
    expect((await read()).status).toBe(403);
    expect((await read()).status).toBe(403);
    expect(named("fetch_site_refused")).toEqual([
      expect.objectContaining({ via: "http", site: "same-site" }),
    ]);
  });

  it("a held preview port leaves the daemon up, logs preview_listener_unavailable once, and the app has no frame-src", async () => {
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    try {
      const { t, named } = await boot((holder.address() as AddressInfo).port);
      expect((await httpRequest(`${t.base}/healthz`)).status).toBe(200);
      expect(named("preview_listener_unavailable")).toEqual([
        expect.objectContaining({ code: "EADDRINUSE" }),
      ]);
      const csp = String((await httpRequest(`${t.base}/healthz`)).headers["content-security-policy"]);
      expect(csp).not.toContain("frame-src");
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });

  it("stop() closes the listener", async () => {
    const { t, port } = await boot();
    expect((await httpRequest(`http://127.0.0.1:${port}/`)).status).toBe(404);
    await t.stop();
    await expect(httpRequest(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});
