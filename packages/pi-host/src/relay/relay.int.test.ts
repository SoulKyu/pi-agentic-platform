import { type ChildProcess, fork } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RelayReport } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { loopbackCertificate } from "../testing/self-signed.ts";
import { presentedKey } from "./keys.ts";
import { pathAllowed, routeOf } from "./routes.ts";

/*
 * Mutants (RT-43) of the route table, each run for real (the unit files hold the same mutants):
 *  - segment check dropped, any method accepted, a plain object for the api table, address binding dropped:
 *    each fails a named case of routes.test.ts / keys.test.ts, and the "wrong address" case here.
 */
const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const KEY = "ab".repeat(32);
const AGENT = "scout-0001";
const REAL = "sk-REAL-PROVIDER-KEY-FROM-MODELS-JSON";
const MODEL = "m-1";
const tmp: string[] = [];
const children: ChildProcess[] = [];
const servers: Array<http.Server | https.Server> = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(tmp.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("what each Pi client sends passes the route table", () => {
  const apis = [
    ["anthropic-messages", "@earendil-works/pi-ai/api/anthropic-messages", "anthp"],
    ["openai-completions", "@earendil-works/pi-ai/api/openai-completions", "oaic"],
    ["openai-responses", "@earendil-works/pi-ai/api/openai-responses", "oair"],
    ["google-generative-ai", "@earendil-works/pi-ai/api/google-generative-ai", "gem"],
  ] as const;

  it.each(apis)(
    "%s: its request is a provider route its api serves, keyed by the relay key",
    async (api, module, provider) => {
      const seen: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
      const real = globalThis.fetch;
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = input instanceof Request ? input : null;
        seen.push({
          url: String(request?.url ?? input),
          method: init?.method ?? request?.method ?? "GET",
          headers: Object.fromEntries(new Headers(init?.headers ?? request?.headers).entries()),
        });
        return new Response(JSON.stringify({ error: { message: "stop" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
      try {
        const { stream } = (await import(module)) as {
          stream(model: unknown, context: unknown, options: unknown): AsyncIterable<unknown>;
        };
        const model = {
          id: MODEL,
          name: "m",
          api,
          provider,
          baseUrl: `http://llm.internal:7842/${provider}`,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          reasoning: false,
          contextWindow: 1000,
          maxTokens: 100,
        };
        for await (const event of stream(
          model,
          { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
          { apiKey: KEY },
        ))
          void event;
      } finally {
        globalThis.fetch = real;
      }
      // Every client of the four apis uses `fetch`; a client that did not would be replayed with its exact Host here.
      expect(seen).toHaveLength(1);
      const [got] = seen;
      const url = new URL(got?.url ?? "");
      expect(url.host).toBe("llm.internal:7842");
      const route = routeOf(got?.method, url.host, `${url.pathname}${url.search}`);
      expect(route?.kind).toBe("provider");
      if (route?.kind !== "provider") return;
      expect(route.provider).toBe(provider);
      expect(pathAllowed(api, route.path), route.path).toBe(true);
      expect(presentedKey(got?.headers ?? {})).toBe(KEY);
    },
  );
});

interface Bed {
  readonly port: number;
  readonly upstream: Array<{ url: string | undefined; headers: http.IncomingHttpHeaders; body: string }>;
  readonly records: Array<Record<string, unknown>>;
  readonly stderr: () => string;
  readonly child: ChildProcess;
}

/** The real `pap-relay` process: Pi's files in a temp agent folder, an HTTPS upstream on loopback that only this test trusts. */
async function startRelay(listen = "127.0.0.1:0"): Promise<Bed> {
  const dir = await fs.mkdtemp(join(tmpdir(), "relay-int-"));
  tmp.push(dir);
  const { cert, key } = loopbackCertificate(dir);
  const upstream: Bed["upstream"] = [];
  const server = https.createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      upstream.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"delta":"he"}\n\n');
      res.end('data: {"delta":"llo"}\n\ndata: [DONE]\n\n');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (server.address() as AddressInfo).port;
  const agentDir = join(dir, "agent");
  await fs.mkdir(agentDir);
  await fs.writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        acme: {
          baseUrl: `https://127.0.0.1:${upstreamPort}/v4`,
          api: "openai-completions",
          apiKey: REAL,
          headers: { "X-Org": "acme" },
          models: [{ id: MODEL }],
        },
      },
    }),
  );
  const child = fork(MAIN, ["--listen", listen], {
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      LANG: "C.UTF-8",
      PI_CODING_AGENT_DIR: agentDir,
      NODE_EXTRA_CA_CERTS: cert,
    },
    execArgv: ["--conditions=development", "--disable-warning=ExperimentalWarning"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  const records: Array<Record<string, unknown>> = [];
  child.on("message", (record) => records.push(record as Record<string, unknown>));
  const errors: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk.toString()));
  child.stdout?.resume();
  return { port: 0, upstream, records, stderr: () => errors.join(""), child };
}

const ready = async (bed: Bed): Promise<number> => {
  await until(
    async () => bed.records.find((record) => record.type === "relay_ready"),
    (record) => record !== undefined,
  );
  const record = RelayReport.parse(bed.records.find((entry) => entry.type === "relay_ready"));
  return record.type === "relay_ready" ? record.port : 0;
};
/** Polls one attempt at a time until `done` (the relay handles IPC commands in order, on its own schedule). */
async function until<T>(attempt: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await attempt();
    if (done(value)) return value;
    if (Date.now() - started > 20_000) throw new Error("timed out");
    await new Promise((resolve) => setImmediate(resolve));
  }
}
const post = (port: number, body: string, key = KEY) =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/acme/chat/completions",
        headers: {
          host: "llm.internal:7842",
          "content-length": String(Buffer.byteLength(body)),
          authorization: `Bearer ${key}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
const grant = (bed: Bed, launch: { launchId?: string; key?: string; address?: string } = {}) =>
  bed.child.send({
    type: "relay_grant",
    launchId: launch.launchId ?? "a".repeat(32),
    agentId: AGENT,
    key: launch.key ?? KEY,
    address: launch.address ?? "127.0.0.1",
  });
const policy = (bed: Bed, model = MODEL) =>
  bed.child.send({
    type: "agent_policy",
    agentId: AGENT,
    models: [{ provider: "acme", id: model }],
    claude: false,
    blocked: null,
  });

describe("the relay process", () => {
  it("serves a VM request with the real key from Pi's files, never the relay key, and the stream comes back unchanged", async () => {
    const bed = await startRelay();
    const port = await ready(bed);
    grant(bed);
    policy(bed);
    const body = JSON.stringify({ model: MODEL, stream: true, messages: [] });
    const reply = await until(
      () => post(port, body),
      (answer) => answer.status === 200,
    );
    expect(reply.text).toBe('data: {"delta":"he"}\n\ndata: {"delta":"llo"}\n\ndata: [DONE]\n\n');
    expect(bed.upstream).toHaveLength(1);
    const [seen] = bed.upstream;
    expect(seen?.url).toBe("/v4/chat/completions");
    expect(seen?.headers.authorization).toBe(`Bearer ${REAL}`);
    expect(seen?.headers["x-org"]).toBe("acme");
    expect(JSON.stringify(seen?.headers)).not.toContain(KEY);
    expect(seen?.body).toBe(body);
    expect(bed.stderr()).not.toContain(REAL);
    expect(bed.stderr()).not.toContain(KEY);
  });

  it("refuses the key from another address, a model outside the list and a revoked key; one request reaches the upstream", async () => {
    const bed = await startRelay();
    const port = await ready(bed);
    const OTHER = "cd".repeat(32);
    grant(bed, { launchId: "a".repeat(32), key: KEY, address: "10.213.0.9" });
    grant(bed, { launchId: "b".repeat(32), key: OTHER, address: "127.0.0.1" });
    policy(bed);
    const body = JSON.stringify({ model: MODEL, messages: [] });
    // The second launch is live, so the first (same agent, another address) was handled before it.
    await until(
      () => post(port, body, OTHER),
      (answer) => answer.status === 200,
    );
    const wrongAddress = await post(port, body, KEY);
    expect(wrongAddress.status).toBe(403);
    expect(JSON.parse(wrongAddress.text)).toEqual({ error: "key" });
    policy(bed, "other");
    const wrongModel = await until(
      () => post(port, body, OTHER),
      (answer) => answer.status !== 200,
    );
    expect(JSON.parse(wrongModel.text)).toEqual({ error: "model" });
    bed.child.send({ type: "relay_revoke", launchId: "b".repeat(32) });
    const revoked = await until(
      () => post(port, body, OTHER),
      (answer) => answer.text.includes('"key"'),
    );
    expect(revoked.status).toBe(403);
    expect(bed.upstream).toHaveLength(1);
    expect(bed.stderr()).toContain('agent_relay_refused {"agentId":"scout-0001","reason":"model"}');
    expect(bed.stderr()).toContain('agent_relay_refused {"agentId":null,"reason":"key"}');
    expect(bed.stderr()).not.toContain(KEY);
    expect(bed.stderr()).not.toContain(OTHER);
  });

  it("drops a command that does not parse and logs its type only", async () => {
    const bed = await startRelay();
    await ready(bed);
    bed.child.send({ type: "relay_grant", launchId: "short", agentId: AGENT, key: KEY, address: "0.0.0.0" });
    bed.child.send({ type: "claude_token", token: 12 });
    bed.child.send("not an object");
    await until(
      async () => bed.stderr(),
      (text) => text.split("command_dropped").length > 3,
    );
    expect(bed.stderr()).toContain('command_dropped {"type":"relay_grant"}');
    expect(bed.stderr()).toContain('command_dropped {"type":"claude_token"}');
    expect(bed.stderr()).toContain('command_dropped {"type":"unknown"}');
    expect(bed.stderr()).not.toContain(KEY);
  });

  it("refuses a wildcard listen address and exits (AVM-P10)", async () => {
    for (const listen of ["0.0.0.0:0", "0.0.0.0:7842", "::", "[::]:7842", "10.9.9.9:1"]) {
      const bed = await startRelay(listen);
      const code = await new Promise<number | null>((resolve) =>
        bed.child.once("exit", (exitCode) => resolve(exitCode)),
      );
      expect(code, listen).toBe(64);
      expect(bed.records).toEqual([]);
    }
  });

  it("refuses to start without --listen", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "relay-int-"));
    tmp.push(dir);
    const child = fork(MAIN, [], {
      env: { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: dir },
      execArgv: ["--conditions=development", "--disable-warning=ExperimentalWarning"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    children.push(child);
    expect(await new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)))).toBe(
      64,
    );
  });
});
