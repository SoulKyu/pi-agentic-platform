import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../clock.ts";
import type { OtlpConfig } from "../config.ts";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";

// A collector on 127.0.0.1 with an ephemeral port: the only place the exporter is allowed to reach in a test.
interface Received {
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
  /** Wall-clock ms the request arrived and the socket closed (null while open). */
  readonly arrivedAt: number;
  closedAt: number | null;
}

const HEADER_VALUE = "k-0123456789";
const SCRIPT = { steps: [{ text: "hi" }] };

let collector: Server | undefined;
let daemon: TestDaemon | undefined;
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  collector?.closeAllConnections();
  await new Promise<void>((resolve) => (collector ? collector.close(() => resolve()) : resolve()));
  collector = undefined;
});

async function startCollector(
  mode: "ok" | "hang" | "redirect",
): Promise<{ endpoint: string; received: Received[] }> {
  const received: Received[] = [];
  collector = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const entry: Received = {
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        arrivedAt: Date.now(),
        closedAt: null,
      };
      res.on("close", () => (entry.closedAt = Date.now()));
      received.push(entry);
      if (mode === "hang") return;
      if (mode === "redirect") res.writeHead(302, { location: "/elsewhere" });
      else res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => collector?.listen(0, "127.0.0.1", resolve));
  const { port } = collector.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${port}`, received };
}

const otlp = (endpoint: string): OtlpConfig => ({
  endpoint,
  serviceName: "pap-int",
  headers: () => ({ "x-test-key": HEADER_VALUE }),
});

async function owner(t: TestDaemon) {
  const cookie = await t.login();
  return t.connect(cookie);
}

describe("OTLP export", () => {
  it("posts the spans of an RPC call every 10 s and the metrics every 60 s, with the configured header and nothing private", async () => {
    const { endpoint, received } = await startCollector("ok");
    const clock = createFakeClock();
    daemon = await startTestDaemon(SCRIPT, { config: { otlp: otlp(endpoint) }, deps: { clock } });
    const client = await owner(daemon);
    const created = await client.call("sessions.create", { cwd: daemon.cwd });
    if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
    const sessionId = (created.result as { sessionId: string }).sessionId;
    client.close();

    await clock.advance(10_000);
    await vi.waitFor(() => expect(received.filter((r) => r.url === "/v1/traces")).toHaveLength(1), {
      timeout: 5_000,
    });
    const traces = received.find((r) => r.url === "/v1/traces");
    expect(traces?.headers["x-test-key"]).toBe(HEADER_VALUE);
    expect(traces?.headers["content-type"]).toBe("application/json");
    expect(traces?.body).toContain("rpc.sessions.create");
    for (const leak of [sessionId, daemon.cwd, daemon.home, daemon.root, HEADER_VALUE]) {
      expect(traces?.body).not.toContain(leak);
    }
    const resource = (
      JSON.parse(traces?.body ?? "{}") as {
        resourceSpans: Array<{ resource: { attributes: Array<{ key: string }> } }>;
      }
    ).resourceSpans[0]?.resource;
    expect(resource?.attributes.map((a) => a.key)).toEqual(["service.name", "service.version"]);

    await clock.advance(50_000);
    await vi.waitFor(() => expect(received.some((r) => r.url === "/v1/metrics")).toBe(true), {
      timeout: 5_000,
    });
    const metrics = received.find((r) => r.url === "/v1/metrics");
    expect(metrics?.headers["x-test-key"]).toBe(HEADER_VALUE);
    expect(metrics?.body).toContain("pap_workers_max");
    for (const leak of [sessionId, daemon.cwd, daemon.home, HEADER_VALUE]) {
      expect(metrics?.body).not.toContain(leak);
    }
  });

  it("does not follow a redirect", async () => {
    const { endpoint, received } = await startCollector("redirect");
    const clock = createFakeClock();
    daemon = await startTestDaemon(SCRIPT, { config: { otlp: otlp(endpoint) }, deps: { clock } });
    const client = await owner(daemon);
    const traces = () => received.filter((r) => r.url === "/v1/traces");
    await client.call("sessions.create", { cwd: daemon.cwd });
    await clock.advance(10_000);
    await vi.waitFor(() => expect(traces()).toHaveLength(1), { timeout: 5_000 });
    // The second POST arrives after whatever the first one would have chased.
    await client.call("sessions.create", { cwd: daemon.cwd });
    await clock.advance(10_000);
    await vi.waitFor(() => expect(traces()).toHaveLength(2), { timeout: 5_000 });
    client.close();
    expect(received.map((r) => r.url)).not.toContain("/elsewhere");
  });

  it("flushes once at stop and gives the flush up after 2 s when the collector never answers", async () => {
    const { endpoint, received } = await startCollector("hang");
    daemon = await startTestDaemon(SCRIPT, { config: { otlp: otlp(endpoint) } });
    const client = await owner(daemon);
    await client.call("sessions.create", { cwd: daemon.cwd });
    client.close();

    await daemon.daemon.stop();
    const posts = received.filter((r) => r.url === "/v1/traces");
    expect(posts).toHaveLength(1);
    // The 2 s is the flush's own deadline (the stop around it has none): the request is cut at about that mark.
    await vi.waitFor(() => expect(posts[0]?.closedAt).not.toBeNull(), { timeout: 5_000 });
    const flushed = (posts[0]?.closedAt ?? 0) - (posts[0]?.arrivedAt ?? 0);
    expect(flushed).toBeGreaterThanOrEqual(1_900);
    expect(flushed).toBeLessThan(2_600);
  });
});
