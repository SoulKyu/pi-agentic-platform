import { describe, expect, it } from "vitest";
import { KEY, OTHER_AGENT, OTHER_KEY, TOKEN, asAgent, bed, chat, send } from "../testing/relay-bed.ts";

/* The bridge (`claude.internal`): its own credential, the same key, model and state checks. */
describe("the relay server: the bridge", () => {
  const claudeBody = JSON.stringify({ model: "claude-sonnet-4-5", messages: [] });
  it("answers 503 when the relay holds no Claude token", async () => {
    const { port, seen } = await bed({ claudeToken: null });
    const reply = await send(port, {
      path: "/v1/messages?beta=true",
      host: "claude.internal:7842",
      headers: asAgent,
      body: claudeBody,
    });
    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body)).toEqual({ error: "no_claude_token" });
    expect(seen).toEqual([]);
  });

  it("forwards with the owner's token, never the relay key", async () => {
    const { port, seen } = await bed();
    const reply = await send(port, {
      path: "/v1/messages?beta=true",
      host: "claude.internal:7842",
      headers: { ...asAgent, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" },
      body: claudeBody,
    });
    expect(reply.status).toBe(200);
    expect(seen[0]?.url).toBe("/v1/messages?beta=true");
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.stringify(seen[0]?.headers)).not.toContain(KEY);
  });

  it("refuses an agent without the bridge, a model that is not claude's and a paused agent", async () => {
    const off = await bed({ claude: false });
    const refusedOff = await send(off.port, {
      path: "/v1/messages",
      host: "claude.internal:7842",
      headers: asAgent,
      body: claudeBody,
    });
    expect(refusedOff.status).toBe(403);
    expect(JSON.parse(refusedOff.body)).toEqual({ error: "model" });
    const on = await bed();
    const other = await send(on.port, {
      path: "/v1/messages",
      host: "claude.internal:7842",
      headers: asAgent,
      body: chat("gpt-5"),
    });
    expect(JSON.parse(other.body)).toEqual({ error: "model" });
    const paused = await bed({ blocked: "paused" });
    const refusedPaused = await send(paused.port, {
      path: "/v1/messages",
      host: "claude.internal:7842",
      headers: asAgent,
      body: claudeBody,
    });
    expect(JSON.parse(refusedPaused.body)).toEqual({ error: "paused" });
    expect([off.seen, on.seen, paused.seen]).toEqual([[], [], []]);
  });

  it("serves each box with its own owner's token, and a box whose owner has none is refused (M14)", async () => {
    const MEMBER = "sk-ant-oat01-MEMBER-CLAUDE-TOKEN";
    const { port, seen, policy, keys } = await bed();
    keys.add({
      launchId: "c".repeat(32),
      box: OTHER_AGENT,
      key: Buffer.from(OTHER_KEY, "hex"),
      address: "127.0.0.1",
    });
    const models = [{ provider: "zai", id: "glm-4.6" }];
    policy.set({ box: OTHER_AGENT, models, claude: true, claudeToken: MEMBER, blocked: null });
    const ask = (key: string) =>
      send(port, {
        path: "/v1/messages",
        host: "claude.internal:7842",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: claudeBody,
      });
    expect((await ask(KEY)).status).toBe(200);
    expect((await ask(OTHER_KEY)).status).toBe(200);
    expect(seen.map((request) => request.headers.authorization)).toEqual([
      `Bearer ${TOKEN}`,
      `Bearer ${MEMBER}`,
    ]);
    // The member's owner clears the token: the next policy push leaves that box with none, the other box keeps its own.
    policy.set({ box: OTHER_AGENT, models, claude: true, claudeToken: null, blocked: null });
    const refused = await ask(OTHER_KEY);
    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.body)).toEqual({ error: "no_claude_token" });
    expect((await ask(KEY)).status).toBe(200);
    expect(seen).toHaveLength(3);
  });

  it("answers the 503 only to an agent that passed the key and model checks", async () => {
    const { port } = await bed({ claudeToken: null });
    const noKey = await send(port, {
      path: "/v1/messages",
      host: "claude.internal:7842",
      headers: { "content-type": "application/json" },
      body: claudeBody,
    });
    expect(noKey.status).toBe(403);
  });
});
