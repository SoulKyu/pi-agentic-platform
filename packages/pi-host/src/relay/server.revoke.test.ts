import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { KEY, asAgent, bed, chat, send } from "../testing/relay-bed.ts";

/*
 * Mutants (RT-43), each run for real:
 *  - M-revoke-streams: drop the `onRemove` subscription in `createRelayServer` -> "ends the stream of a revoked launch" hangs
 *    until its timeout (the client's response never ends).
 *  - M-wrong-launch: end every stream on any revoke -> "leaves the streams of other launches" fails.
 *  - M-regrant: `add` notifies like `remove` -> "a second grant for a live launch" fails.
 *  - M-duplicate-model: `modelOf` stops refusing duplicates -> "refuses a duplicate model key" reaches the upstream.
 */
const LAUNCH_A = "a".repeat(32);

interface Open {
  readonly first: Promise<void>;
  readonly ended: Promise<"end" | "error">;
}

/** A streaming request whose upstream sends one chunk and then stays silent; `first` resolves at that chunk. */
function openStream(port: number, key: string, path = "/zai/chat/completions"): Open {
  let gotFirst: () => void = () => {};
  const first = new Promise<void>((resolve) => {
    gotFirst = resolve;
  });
  const ended = new Promise<"end" | "error">((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path,
        headers: {
          host: "llm.internal:7842",
          authorization: `Bearer ${key}`,
          "content-length": String(Buffer.byteLength(chat())),
        },
      },
      (res) => {
        res.on("data", () => gotFirst());
        res.on("end", () => resolve("end"));
        res.on("error", () => resolve("error"));
        res.on("close", () => resolve("error"));
      },
    );
    req.on("error", () => resolve("error"));
    req.end(chat());
  });
  return { first, ended };
}

/** A request to the upstream itself: whatever the relay sent it before has been taken by the time this is answered. */
const probeUpstream = (port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/probe" }, (res) => {
      res.resume();
      res.on("end", () => resolve());
    });
    req.on("error", reject);
    req.end("{}");
  });

/** True when `ended` has not settled after many turns of the event loop and a round trip to the relay. */
async function stillRunning(ended: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void ended.then(() => (settled = true));
  for (let turn = 0; turn < 50; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
  return !settled;
}

const holding = (_req: http.IncomingMessage, res: http.ServerResponse): void => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write("data: one\n\n");
};

describe("revoking a launch's key (T12 carry: relay_revoke ends running streams)", () => {
  it("ends the stream of a revoked launch and closes its upstream request (M-revoke-streams)", async () => {
    const closedUpstream: string[] = [];
    const { port, keys } = await bed({
      upstream: (req, res) => {
        res.on("close", () => closedUpstream.push("closed"));
        holding(req, res);
      },
    });
    const stream = openStream(port, KEY);
    await stream.first;
    keys.remove(LAUNCH_A);
    expect(await stream.ended).toBe("error");
    await expect.poll(() => closedUpstream.length).toBe(1);
    // The key is refused from now on, too.
    const after = await send(port, { path: "/zai/chat/completions", headers: asAgent, body: chat() });
    expect(JSON.parse(after.body)).toEqual({ error: "key" });
  });

  it("leaves the streams of other launches running (M-wrong-launch)", async () => {
    const { port, keys } = await bed({ upstream: holding });
    const third = "ef".repeat(32);
    keys.add({
      launchId: "c".repeat(32),
      box: { kind: "agent", id: "other-0002" },
      key: Buffer.from(third, "hex"),
      address: "127.0.0.1",
    });
    const mine = openStream(port, KEY);
    const theirs = openStream(port, third);
    await Promise.all([mine.first, theirs.first]);
    keys.remove("c".repeat(32));
    expect(await theirs.ended).toBe("error");
    // Several turns of the event loop, not a delay: a stream the revoke wrongly ended has settled by now.
    expect(await stillRunning(mine.ended)).toBe(true);
    keys.remove(LAUNCH_A);
    expect(await mine.ended).toBe("error");
  });

  it("a second grant for a live launch keeps its streams (M-regrant)", async () => {
    const { port, keys } = await bed({ upstream: holding });
    const stream = openStream(port, KEY);
    await stream.first;
    keys.add({
      launchId: LAUNCH_A,
      box: { kind: "agent", id: "scout-0001" },
      key: Buffer.from(KEY, "hex"),
      address: "127.0.0.1",
    });
    expect(await stillRunning(stream.ended)).toBe(true);
    keys.remove(LAUNCH_A);
    expect(await stream.ended).toBe("error");
  });
});

describe("a duplicate model key (T12 carry)", () => {
  it("refuses a duplicate model key before any credential is looked up (M-duplicate-model)", async () => {
    const { port, seen, resolveProvider } = await bed();
    const body = '{"model":"glm-4.6","model":"not-allowed","messages":[]}';
    const reply = await send(port, { path: "/zai/chat/completions", headers: asAgent, body });
    expect(reply.status).toBe(403);
    expect(JSON.parse(reply.body)).toEqual({ error: "model" });
    expect(seen).toEqual([]);
    expect(resolveProvider).not.toHaveBeenCalled();
    // The same body the other way round (the allowed one last) is refused as well: no spelling gets through.
    const swapped = await send(port, {
      path: "/zai/chat/completions",
      headers: asAgent,
      body: '{"model":"not-allowed","model":"glm-4.6"}',
    });
    expect(JSON.parse(swapped.body)).toEqual({ error: "model" });
    expect(seen).toEqual([]);
  });
});

// I3 / ledger line 177: the window of `resolveProvider` (a `!command` key, an OAuth refresh) is not a place to forget a revoke.
describe("a request that waits for its credential (I3)", () => {
  /** A `resolveProvider` the test releases; the request is sent and waits inside it. */
  async function waiting(over: Parameters<typeof bed>[0] = {}) {
    const context = await bed(over);
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    context.resolveProvider.mockImplementation((async () => {
      entered();
      await gate;
      return {
        api: "openai-completions" as const,
        baseUrl: `http://127.0.0.1:${context.upstreamPort}/v4/`,
        credential: { value: "REAL-PROVIDER-SECRET", headers: {} },
      };
    }) as never);
    const reply = send(context.port, { path: "/zai/chat/completions", headers: asAgent, body: chat() }).catch(
      () => null,
    );
    await inside;
    return { ...context, release: () => release(undefined), reply };
  }

  // Mutant M-after-wait: the checks after the await dropped -> the credential goes upstream.
  it("is not forwarded when its launch was revoked meanwhile", async () => {
    const { keys, seen, release, reply, upstreamPort } = await waiting();
    keys.remove(LAUNCH_A);
    // The response's close has fired by the time the credential arrives (the real wait is seconds, not a microtask).
    await stillRunning(new Promise(() => {}));
    release();
    await reply;
    await probeUpstream(upstreamPort);
    await stillRunning(new Promise(() => {}));
    expect(seen.filter((got) => got.url !== "/probe")).toEqual([]);
  });

  // AVM-E41 m1. Mutant: the handler returns with no answer when the grant changed (and the response is open) -> the reply never
  // comes and the address keeps its slot.
  it("is refused `key`, not left hanging, when its grant was replaced meanwhile (the slot is freed)", async () => {
    const { keys, seen, release, reply, upstreamPort } = await waiting();
    // A key rotation or a re-grant to the same address by another launch: the response is still open, the grant is not its own.
    keys.add({
      launchId: "c".repeat(32),
      box: { kind: "agent", id: "scout-0001" },
      key: Buffer.from(KEY, "hex"),
      address: "127.0.0.1",
    });
    let answered = false;
    void reply.then(() => (answered = true));
    release();
    // The old code never answered: the condition below then times out instead of the test sleeping.
    await vi.waitFor(() => expect(answered).toBe(true), { timeout: 2_000 });
    const answer = await reply;
    expect(JSON.parse(answer?.body ?? "{}")).toEqual({ error: "key" });
    await probeUpstream(upstreamPort);
    expect(seen.filter((got) => got.url !== "/probe")).toEqual([]);
  });

  it("is refused when the agent was paused meanwhile", async () => {
    const { policy, seen, release, reply } = await waiting();
    policy.set({
      box: { kind: "agent", id: "scout-0001" },
      models: [{ provider: "zai", id: "glm-4.6" }],
      claude: true,
      claudeToken: null,
      blocked: "paused",
    });
    release();
    const answer = await reply;
    expect(JSON.parse(answer?.body ?? "{}")).toEqual({ error: "paused" });
    expect(seen).toEqual([]);
  });

  it("is refused when the agent's budget was reached meanwhile", async () => {
    const { policy, seen, release, reply } = await waiting();
    policy.set({
      box: { kind: "agent", id: "scout-0001" },
      models: [{ provider: "zai", id: "glm-4.6" }],
      claude: true,
      claudeToken: null,
      blocked: "budget",
    });
    release();
    expect(JSON.parse((await reply)?.body ?? "{}")).toEqual({ error: "budget" });
    expect(seen).toEqual([]);
  });

  it("is forwarded when nothing changed", async () => {
    const { seen, release, reply } = await waiting();
    release();
    expect((await reply)?.status).toBe(200);
    expect(seen).toHaveLength(1);
  });
});
