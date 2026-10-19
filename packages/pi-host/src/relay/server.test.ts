import { describe, expect, it } from "vitest";
import { KEY, REAL, asAgent, bed, chat, send } from "../testing/relay-bed.ts";

/*
 * Mutants (RT-43), each run for real:
 *  - M-leak: forward the VM's authorization upstream -> the happy path's "without the relay key" fails.
 */
describe("the relay server: a request that speaks for an agent", () => {
  it("reaches the upstream with the real key, never the relay key, and the answer comes back unchanged (M-leak)", async () => {
    const { port, seen, resolveProvider } = await bed();
    const reply = await send(port, {
      path: "/zai/chat/completions",
      headers: {
        ...asAgent,
        "x-api-key": KEY,
        cookie: "z=1",
        "x-stainless-os": "Linux",
        accept: "text/event-stream",
      },
      body: chat(),
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toBe("data: one\n\ndata: [DONE]\n\n");
    expect(reply.headers["content-type"]).toBe("text/event-stream");
    expect(reply.headers["x-request-id"]).toBe("req-1");
    expect(reply.headers["set-cookie"]).toBeUndefined();
    expect(resolveProvider).toHaveBeenCalledExactlyOnceWith("zai");
    expect(seen).toHaveLength(1);
    const [got] = seen;
    expect(got?.method).toBe("POST");
    expect(got?.url).toBe("/v4/chat/completions");
    expect(got?.headers.authorization).toBe(`Bearer ${REAL}`);
    expect(got?.headers["x-org"]).toBe("acme");
    expect(got?.headers["x-stainless-os"]).toBe("Linux");
    expect(got?.headers["x-api-key"]).toBeUndefined();
    expect(got?.headers.cookie).toBeUndefined();
    expect(JSON.stringify(got?.headers)).not.toContain(KEY);
    expect(got?.body.toString("utf8")).toBe(chat());
  });

  it("passes the query through and reads a Google model from the path", async () => {
    const { port, seen } = await bed();
    const reply = await send(port, {
      path: "/gem/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
      headers: { "x-goog-api-key": KEY },
      body: JSON.stringify({ contents: [] }),
    });
    expect(reply.status).toBe(200);
    expect(seen[0]?.url).toBe("/v4/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse");
    expect(seen[0]?.headers["x-goog-api-key"]).toBe(REAL);
    const refused = await send(port, {
      path: "/gem/v1beta/models/gemini-9-ultra:streamGenerateContent",
      headers: { "x-goog-api-key": KEY },
      body: "{}",
    });
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body)).toEqual({ error: "model" });
  });

  it("refuses a path the provider's api does not serve, after the credential lookup only", async () => {
    const { port, seen } = await bed({ api: "anthropic-messages" });
    const reply = await send(port, { path: "/zai/chat/completions", headers: asAgent, body: chat() });
    expect(reply.status).toBe(403);
    expect(JSON.parse(reply.body)).toEqual({ error: "route" });
    expect(seen).toEqual([]);
  });

  it("answers 403 `provider` when no credential resolves", async () => {
    const { port, seen } = await bed({ models: [{ provider: "nobody", id: "m" }] });
    const reply = await send(port, { path: "/nobody/chat/completions", headers: asAgent, body: chat("m") });
    expect(reply.status).toBe(403);
    expect(JSON.parse(reply.body)).toEqual({ error: "provider" });
    expect(seen).toEqual([]);
  });

  it("does not follow a redirect and drops its Location", async () => {
    const { port, seen } = await bed({
      upstream: (_req, res) => {
        res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" });
        res.end();
      },
    });
    const reply = await send(port, { path: "/zai/chat/completions", headers: asAgent, body: chat() });
    expect(reply.status).toBe(302);
    expect(reply.headers.location).toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  it("answers 502 with a fixed body when the upstream breaks", async () => {
    const { port } = await bed({ upstream: (req) => req.socket.destroy() });
    const reply = await send(port, { path: "/zai/chat/completions", headers: asAgent, body: chat() });
    expect(reply.status).toBe(502);
    expect(JSON.parse(reply.body)).toEqual({ error: "upstream" });
  });

  it("cuts an upstream that sends nothing for the idle time", async () => {
    const { port } = await bed({ idleMs: 50, upstream: () => {} });
    const reply = await send(port, { path: "/zai/chat/completions", headers: asAgent, body: chat() });
    expect(reply.status).toBe(502);
    expect(JSON.parse(reply.body)).toEqual({ error: "upstream" });
  });
});
