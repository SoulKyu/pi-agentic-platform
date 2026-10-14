import http from "node:http";
import type { AddressInfo } from "node:net";

export interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

export interface FixtureReply {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  /** A string is sent as is; anything else as JSON. */
  readonly body?: unknown;
  /** Never answer (the request hangs until the client gives up). */
  readonly hang?: boolean;
}

export interface ProviderFixture {
  readonly baseUrl: string;
  readonly requests: SeenRequest[];
  reply(route: string, answer: FixtureReply | ((request: SeenRequest) => FixtureReply)): void;
  close(): Promise<void>;
}

/** An SSE chat completion the way an OpenAI-compatible gateway streams one. */
export const completionStream = (text: string): string =>
  [
    { choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    },
  ]
    .map(
      (chunk) =>
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m1", ...chunk })}\n\n`,
    )
    .join("")
    .concat("data: [DONE]\n\n");

/**
 * A loopback HTTP server a test starts: no outside network. Routes are `METHOD path` (`GET /v1/models`); a route
 * nobody set up answers 404. Tests that use it must not load the network guard, which refuses loopback too.
 */
export async function startProviderFixture(): Promise<ProviderFixture> {
  const requests: SeenRequest[] = [];
  const routes = new Map<string, FixtureReply | ((request: SeenRequest) => FixtureReply)>();
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const seen: SeenRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(seen);
      const route = routes.get(`${seen.method} ${seen.url.split("?")[0]}`);
      const answer = typeof route === "function" ? route(seen) : route;
      if (answer?.hang) return;
      const body = answer?.body;
      res.writeHead(answer?.status ?? (answer ? 200 : 404), {
        ...(typeof body === "string" ? {} : { "content-type": "application/json" }),
        ...answer?.headers,
      });
      res.end(typeof body === "string" ? body : JSON.stringify(body ?? {}));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    reply: (route, answer) => void routes.set(route, answer),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
