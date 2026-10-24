import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { AGENT, KEY, OTHER_KEY, MIB, asAgent, bed, chat, raw, send } from "../testing/relay-bed.ts";

/*
 * Mutants (RT-43), each run for real:
 *  - M-key-first: look the provider up before the key -> "refuses without the right key and never resolves" fails (spy).
 *  - M-policy-first: resolve before the model check -> "refuses a model outside the agent's list" fails (spy).
 *  - M-concurrency: no per-address limit -> "answers 429 to the ninth concurrent request" fails.
 *  - M-body-limit: no limit while reading -> "refuses a chunked body that grows over 32 MiB" fails.
 *  - M-declared-length: no Content-Length check -> "refuses a body over 32 MiB by its Content-Length" fails.
 *  - M-host-dup: ignore a second Host -> "refuses two Host headers" fails.
 */
describe("the relay server: what never reaches a provider", () => {
  it("refuses without the right key and never resolves a provider (M-key-first)", async () => {
    const { port, resolveProvider, seen, logs } = await bed();
    const none = await send(port, {
      path: "/zai/chat/completions",
      headers: { "content-type": "application/json" },
      body: chat(),
    });
    const wrong = await send(port, {
      path: "/zai/chat/completions",
      headers: { authorization: `Bearer ${"00".repeat(32)}` },
      body: chat(),
    });
    const placeholder = await send(port, {
      path: "/zai/chat/completions",
      headers: { authorization: "Bearer placeholder" },
      body: chat(),
    });
    const foreign = await send(port, {
      path: "/zai/chat/completions",
      headers: { authorization: `Bearer ${OTHER_KEY}` },
      body: chat(),
    });
    for (const reply of [none, wrong, placeholder, foreign]) {
      expect(reply.status).toBe(403);
      expect(JSON.parse(reply.body)).toEqual({ error: "key" });
    }
    expect(resolveProvider).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    expect(logs.filter((line) => line.includes('"reason":"key"'))).toHaveLength(4);
  });

  it("refuses a model outside the agent's list and never resolves a provider (M-policy-first)", async () => {
    const { port, resolveProvider, seen } = await bed();
    for (const body of [chat("gpt-5"), "not json", JSON.stringify({ model: 3 }), "{}"]) {
      const reply = await send(port, { path: "/zai/chat/completions", headers: asAgent, body });
      expect(reply.status).toBe(403);
      expect(JSON.parse(reply.body)).toEqual({ error: "model" });
    }
    const wrongProvider = await send(port, {
      path: "/gem/chat/completions",
      headers: asAgent,
      body: chat("glm-4.6"),
    });
    expect(JSON.parse(wrongProvider.body)).toEqual({ error: "model" });
    expect(resolveProvider).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it("refuses a paused agent and one over budget", async () => {
    for (const blocked of ["paused", "budget"] as const) {
      const { port, resolveProvider, seen } = await bed({ blocked });
      const reply = await send(port, { path: "/zai/chat/completions", headers: asAgent, body: chat() });
      expect(reply.status).toBe(403);
      expect(JSON.parse(reply.body)).toEqual({ error: blocked });
      expect(resolveProvider).not.toHaveBeenCalled();
      expect(seen).toEqual([]);
    }
  });

  it("follows a policy pushed later", async () => {
    const { port, policy, seen } = await bed();
    policy.set({
      box: AGENT,
      models: [{ provider: "zai", id: "glm-4.6" }],
      claude: false,
      blocked: "budget",
    });
    expect((await send(port, { path: "/zai/chat/completions", headers: asAgent, body: chat() })).status).toBe(
      403,
    );
    policy.set({
      box: AGENT,
      models: [{ provider: "zai", id: "glm-4.6" }],
      claude: false,
      blocked: null,
    });
    expect((await send(port, { path: "/zai/chat/completions", headers: asAgent, body: chat() })).status).toBe(
      200,
    );
    expect(seen).toHaveLength(1);
  });

  it("refuses a key presented from a revoked launch", async () => {
    const { port, keys, seen } = await bed();
    keys.remove("a".repeat(32));
    const reply = await send(port, { path: "/zai/chat/completions", headers: asAgent, body: chat() });
    expect(reply.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it("refuses a route before anything else", async () => {
    const { port, resolveProvider } = await bed();
    const cases: Array<Parameters<typeof send>[1]> = [
      { path: "/zai/chat/completions", host: "api.z.ai", headers: asAgent, body: chat() },
      { path: "/zai/chat/completions", method: "GET", headers: asAgent },
      { path: "/zai/../chat/completions", headers: asAgent, body: chat() },
      { path: "/zai/chat/completions?x=1", headers: asAgent, body: chat() },
    ];
    for (const options of cases) {
      const reply = await send(port, options);
      expect(reply.status, JSON.stringify(options)).toBe(403);
      expect(JSON.parse(reply.body)).toEqual({ error: "route" });
    }
    expect(resolveProvider).not.toHaveBeenCalled();
  });

  it("refuses two Host headers (M-host-dup)", async () => {
    const { port, resolveProvider } = await bed();
    const text = raw(
      port,
      `POST /zai/chat/completions HTTP/1.1\r\nHost: llm.internal:7842\r\nHost: evil.example\r\nAuthorization: Bearer ${KEY}\r\nContent-Length: 2\r\n\r\n{}`,
    );
    expect(await text).toMatch(/^HTTP\/1\.1 400 /);
    expect(resolveProvider).not.toHaveBeenCalled();
  });

  it("refuses Transfer-Encoding with Content-Length", async () => {
    const { port, resolveProvider } = await bed();
    const text = await raw(
      port,
      `POST /zai/chat/completions HTTP/1.1\r\nHost: llm.internal:7842\r\nAuthorization: Bearer ${KEY}\r\nTransfer-Encoding: chunked\r\nContent-Length: 2\r\n\r\n2\r\n{}\r\n0\r\n\r\n`,
    );
    expect(text).toMatch(/^HTTP\/1\.1 400 /);
    expect(resolveProvider).not.toHaveBeenCalled();
  });

  it("refuses a body over 32 MiB by its Content-Length (M-body-limit)", async () => {
    const { port, resolveProvider, seen } = await bed();
    const socket = net.connect(port, "127.0.0.1");
    socket.on("error", () => {});
    const answered = new Promise<string>((resolve) => {
      let text = "";
      socket.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        if (text.includes("\r\n\r\n")) resolve(text);
      });
      socket.on("close", () => resolve(text));
    });
    socket.write(
      `POST /zai/chat/completions HTTP/1.1\r\nHost: llm.internal:7842\r\nAuthorization: Bearer ${KEY}\r\nContent-Length: ${32 * MIB + 1}\r\n\r\n`,
    );
    socket.write(Buffer.alloc(MIB, 0x20));
    expect(await answered).toMatch(/^HTTP\/1\.1 413 /);
    socket.destroy();
    expect(resolveProvider).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it("refuses a chunked body that grows over 32 MiB (M-body-limit)", async () => {
    const { port, resolveProvider, seen } = await bed();
    const socket = net.connect(port, "127.0.0.1");
    socket.on("error", () => {});
    const answered = new Promise<string>((resolve) => {
      let text = "";
      socket.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        if (text.includes("\r\n\r\n")) resolve(text);
      });
      socket.on("close", () => resolve(text));
    });
    socket.write(
      `POST /zai/chat/completions HTTP/1.1\r\nHost: llm.internal:7842\r\nAuthorization: Bearer ${KEY}\r\nTransfer-Encoding: chunked\r\n\r\n`,
    );
    const piece = Buffer.alloc(MIB, 0x20);
    for (let i = 0; i < 33 && !socket.destroyed; i++) {
      socket.write(`${MIB.toString(16)}\r\n`);
      socket.write(piece);
      socket.write("\r\n");
    }
    expect(await answered).toMatch(/^HTTP\/1\.1 413 /);
    socket.destroy();
    expect(resolveProvider).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it("accepts a body of exactly 32 MiB", async () => {
    const { port, seen } = await bed();
    const head = `{"model":"glm-4.6","pad":"`;
    const tail = `"}`;
    const body = Buffer.concat([
      Buffer.from(head),
      Buffer.alloc(32 * MIB - head.length - tail.length, 0x61),
      Buffer.from(tail),
    ]);
    expect(body.length).toBe(32 * MIB);
    const reply = await send(port, { path: "/zai/chat/completions", headers: asAgent, body });
    expect(reply.status).toBe(200);
    expect(seen[0]?.body.length).toBe(32 * MIB);
  });

  it("answers 429 to the ninth concurrent request from one address (M-concurrency)", async () => {
    const { port, resolveProvider } = await bed();
    const held: net.Socket[] = [];
    for (let i = 0; i < 8; i++) {
      const socket = net.connect(port, "127.0.0.1");
      socket.on("error", () => {});
      socket.write(
        `POST /zai/chat/completions HTTP/1.1\r\nHost: llm.internal:7842\r\nAuthorization: Bearer ${KEY}\r\nContent-Length: 100\r\n\r\n{`,
      );
      held.push(socket);
    }
    // Each held request is counted when Node hands it to the handler: wait on the ninth's answer, not on a sleep.
    await vi.waitFor(
      async () => {
        // Keyless: until the held requests are counted this probe is a 403 `key`, never a call to a provider.
        const ninth = await send(port, {
          path: "/zai/chat/completions",
          headers: { "content-type": "application/json" },
          body: chat(),
        });
        expect(ninth.status).toBe(429);
        expect(JSON.parse(ninth.body)).toEqual({ error: "busy" });
      },
      { timeout: 5000 },
    );
    expect(resolveProvider).not.toHaveBeenCalled();
    for (const socket of held) socket.destroy();
    // The slots come back when the held requests end.
    await vi.waitFor(
      async () => {
        expect(
          (await send(port, { path: "/zai/chat/completions", headers: asAgent, body: chat() })).status,
        ).toBe(200);
      },
      { timeout: 5000 },
    );
  });
});
