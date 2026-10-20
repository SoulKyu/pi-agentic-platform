import http from "node:http";
import type { AddressInfo } from "node:net";

/** One scripted model answer: text, or one tool call (`args` is sent as the call's JSON arguments). */
export type KataReply = { text: string } | { tool: string; args: Record<string, unknown> };

export interface KataLlm {
  readonly baseUrl: string;
  /** Appends answers; each model request takes the next one, and `ok` once the queue is empty (a tool call never repeats). */
  push(...replies: KataReply[]): void;
  /**
   * Answers for the requests whose body holds `match` (an agent's own prompt text): several agents share one model server, and
   * their requests interleave. Taken before the plain queue; each request takes the next of the first matching list that has any.
   */
  pushFor(match: string, ...replies: KataReply[]): void;
  /** The number of model requests served. */
  readonly served: () => number;
  close(): Promise<void>;
}

const chunk = (delta: object, finish: string | null, usage?: object): string =>
  `data: ${JSON.stringify({
    id: "chatcmpl-t20a",
    object: "chat.completion.chunk",
    created: 1,
    model: "m-1",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage === undefined ? {} : { usage }),
  })}\n\n`;

function stream(reply: KataReply, call: number): string {
  const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 };
  if ("text" in reply)
    return `${chunk({ role: "assistant", content: reply.text }, null)}${chunk({}, "stop", usage)}data: [DONE]\n\n`;
  const toolCall = {
    index: 0,
    id: `call_${call}`,
    type: "function",
    function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
  };
  return `${chunk({ role: "assistant", tool_calls: [toolCall] }, null)}${chunk({}, "tool_calls", usage)}data: [DONE]\n\n`;
}

/**
 * The scripted model of the Kata tests: an OpenAI-compatible endpoint on loopback, which only the host's relay reaches (the relay
 * runs in test mode, where a loopback base URL is allowed). The VM's worker talks to the relay, never to this server.
 */
export async function startKataLlm(): Promise<KataLlm> {
  const queue: KataReply[] = [];
  const keyed: Array<{ match: string; replies: KataReply[] }> = [];
  let served = 0;
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const own = keyed.find((entry) => entry.replies.length > 0 && body.includes(entry.match));
      const next = own?.replies.shift() ?? queue.shift() ?? { text: "ok" };
      served += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(stream(next, served));
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
    push: (...replies) => void queue.push(...replies),
    pushFor: (match, ...replies) => void keyed.push({ match, replies }),
    served: () => served,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
