import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterEach, vi } from "vitest";
import { createRelayKeys } from "../relay/keys.ts";
import { createRelayPolicy } from "../relay/policy.ts";
import { createRelayServer, listenOn } from "../relay/server.ts";
import { createUsage } from "../relay/usage.ts";
import { fakeClock } from "./guest-harness.ts";

/** The relay server on loopback in front of a fake upstream, for server.*.test.ts: the agent, its key and its policy are set up. */
export const KEY = "ab".repeat(32);
export const OTHER_KEY = "cd".repeat(32);
export const AGENT = "scout-0001";
export const REAL = "REAL-PROVIDER-SECRET";
export const TOKEN = "sk-ant-oat01-OWNER-CLAUDE-TOKEN";
export const MIB = 1024 * 1024;

export interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

export async function bed(
  over: {
    blocked?: "paused" | "budget" | null;
    claude?: boolean;
    claudeToken?: string | null;
    api?: "openai-completions" | "google-generative-ai" | "anthropic-messages";
    models?: Array<{ provider: string; id: string }>;
    idleMs?: number;
    upstream?: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void;
  } = {},
) {
  const seen: Seen[] = [];
  const upstreamSockets = new Set<net.Socket>();
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (over.upstream) return over.upstream(req, res, body);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "x-request-id": "req-1",
        "set-cookie": "a=b",
      });
      res.write("data: one\n\n");
      res.end("data: [DONE]\n\n");
    });
  });
  upstream.on("connection", (socket) => {
    upstreamSockets.add(socket);
    socket.on("close", () => upstreamSockets.delete(socket));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const keys = createRelayKeys();
  keys.add({ launchId: "a".repeat(32), agentId: AGENT, key: Buffer.from(KEY, "hex"), address: "127.0.0.1" });
  keys.add({
    launchId: "b".repeat(32),
    agentId: "other-0002",
    key: Buffer.from(OTHER_KEY, "hex"),
    address: "10.213.0.9",
  });
  const policy = createRelayPolicy();
  policy.set({
    agentId: AGENT,
    models: over.models ?? [
      { provider: "zai", id: "glm-4.6" },
      { provider: "gem", id: "gemini-2.5-pro" },
    ],
    claude: over.claude ?? true,
    blocked: over.blocked ?? null,
  });
  policy.set({
    agentId: "other-0002",
    models: [{ provider: "zai", id: "glm-4.6" }],
    claude: true,
    blocked: null,
  });
  const clock = fakeClock();
  const reports: unknown[] = [];
  const usage = createUsage(clock, (report) => reports.push(report));
  usage.start();
  const resolveProvider = vi.fn(async (provider: string) =>
    provider === "zai" || provider === "gem"
      ? {
          api:
            provider === "gem"
              ? ("google-generative-ai" as const)
              : (over.api ?? ("openai-completions" as const)),
          baseUrl: `http://127.0.0.1:${upstreamPort}/v4/`,
          credential: { value: REAL, headers: { "x-org": "acme" } },
        }
      : null,
  );
  const logs: string[] = [];
  const server = createRelayServer({
    keys,
    policy,
    usage,
    resolveProvider,
    claudeToken: () => (over.claudeToken === undefined ? TOKEN : over.claudeToken),
    claudeUpstream: `http://127.0.0.1:${upstreamPort}`,
    upstreamIdleMs: over.idleMs ?? 300_000,
    log: (line) => logs.push(line),
  });
  const port = await listenOn(server, "127.0.0.1", 0);
  closers.push(async () => {
    usage.stop();
    for (const socket of upstreamSockets) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  return { server, port, seen, keys, policy, usage, clock, reports, resolveProvider, logs, upstreamPort };
}

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}
export function send(
  port: number,
  options: {
    method?: string;
    host?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
  },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = options.body ?? "";
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "POST",
        path: options.path,
        headers: {
          host: options.host ?? "llm.internal:7842",
          "content-length": String(Buffer.byteLength(body)),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
export const chat = (model = "glm-4.6") =>
  JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] });
export const asAgent = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };

/** A raw HTTP/1.1 exchange: for requests Node's own client refuses to build. */
export function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).includes("\r\n\r\n")) socket.destroy();
    });
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", () => {});
  });
}
