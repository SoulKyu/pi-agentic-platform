import { describe, expect, it } from "vitest";
import { AGENT, KEY, OTHER_KEY, REAL, TOKEN, asAgent, bed, chat, send } from "../testing/relay-bed.ts";

/* Attribution (RT-17) and what a log line may hold. */
describe("the relay server: usage and logs", () => {
  it("counts requests, refusals and bytes per agent for the minute", async () => {
    const { port, clock, reports } = await bed();
    await send(port, { path: "/zai/chat/completions", headers: asAgent, body: chat() });
    await send(port, { path: "/zai/chat/completions", headers: asAgent, body: chat("gpt-5") });
    await send(port, {
      path: "/zai/chat/completions",
      headers: { authorization: `Bearer ${"11".repeat(32)}` },
      body: chat(),
    });
    clock.advance(60_000);
    expect(reports).toEqual([
      {
        type: "relay_usage",
        agents: [
          {
            agentId: AGENT,
            requests: 2,
            refused: 1,
            bytesIn: Buffer.byteLength(chat()) + Buffer.byteLength(chat("gpt-5")),
            bytesOut: Buffer.byteLength("data: one\n\ndata: [DONE]\n\n"),
          },
        ],
      },
    ]);
  });

  it("logs a refusal by agent and reason only, never a key, a token, a path or a host", async () => {
    const { port, logs } = await bed();
    await send(port, { path: "/zai/chat/completions", headers: asAgent, body: chat("gpt-5") });
    await send(port, {
      path: "/zai/chat/completions",
      headers: { authorization: `Bearer ${OTHER_KEY}` },
      body: chat(),
    });
    await send(port, { path: "/zai/chat/completions", headers: asAgent, body: chat() });
    await send(port, { path: "/secret-path-xyz/../x", host: "evil.example", headers: asAgent, body: chat() });
    await send(port, {
      path: "/v1/messages",
      host: "claude.internal:7842",
      headers: asAgent,
      body: JSON.stringify({ model: "claude-x" }),
    });
    expect(logs).toContain(`agent_relay_refused ${JSON.stringify({ agentId: AGENT, reason: "model" })}`);
    expect(logs).toContain(`agent_relay_refused ${JSON.stringify({ agentId: null, reason: "key" })}`);
    expect(logs).toContain(`agent_relay_refused ${JSON.stringify({ agentId: null, reason: "route" })}`);
    const text = logs.join("\n");
    for (const secret of [
      KEY,
      OTHER_KEY,
      REAL,
      TOKEN,
      "secret-path-xyz",
      "chat/completions",
      "evil.example",
      "llm.internal",
      "127.0.0.1",
      "acme",
    ])
      expect(text, secret).not.toContain(secret);
    expect(logs.length).toBeGreaterThan(0);
  });
});
