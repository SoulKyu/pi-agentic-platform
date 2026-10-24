import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { forkRelay, relayEnv, relayListenOf } from "./relay-fork.ts";
import { createRelayLink, type PolicyView, type RelayLink } from "./relay-link.ts";
import { pidsWithEnv, removeTree } from "./testing/runtime-bed.ts";

/*
 * The real `pap-relay` child, forked the way the daemon forks it (J1, T12's daemon half), on loopback with a loopback upstream.
 * Mutants (RT-43), each run for real:
 *  - M-wildcard: `relayListenOf` answers `0.0.0.0:0` -> the relay refuses it and exits 64, never ready: every case here fails,
 *    and "listens on loopback only" reads the socket table;
 *  - M-no-replay: the link replays nothing at `relay_ready` -> "a killed relay is restarted and the grant still works" fails;
 *  - M-revoke-streams (pi-host server.ts): see server.revoke.test.ts; here "a revoke ends a running stream" fails too;
 *  - M-env: `relayEnv` passes the daemon's whole environment -> "the child's environment" fails.
 */
const MAIN = fileURLToPath(new URL("../../../../../packages/pi-host/src/relay/main.ts", import.meta.url));
const EXEC_ARGV = ["--conditions=development", "--disable-warning=ExperimentalWarning"];
const KEY = "ab".repeat(32);
const REAL = "sk-REAL-PROVIDER-KEY-IN-PI-FILES";
const AGENT = { kind: "agent", id: "scout-0001" } as const;
const LAUNCH = "a".repeat(32);
const MODEL = "m-1";
const POLICY: PolicyView = { models: [{ provider: "acme", id: MODEL }], claude: false, blocked: null };

interface Bed {
  readonly link: RelayLink;
  readonly lines: Array<Record<string, unknown>>;
  readonly upstream: Array<{ url: string | undefined; headers: http.IncomingHttpHeaders; body: string }>;
  readonly script: string;
  /** Holds the upstream's next streams open (they send one chunk and then stay silent). */
  hold(on: boolean): void;
  policy: PolicyView;
}
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start(over: { daemonEnv?: Record<string, string> } = {}): Promise<Bed> {
  const dir = mkdtempSync(join(tmpdir(), "pap-relay-link-"));
  cleanups.push(() => removeTree(dir));
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir);
  const open = new Set<http.ServerResponse>();
  let holding = false;
  const upstream: Bed["upstream"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      upstream.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"delta":"he"}\n\n');
      if (holding) return void open.add(res);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    for (const res of open) res.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const upstreamPort = (server.address() as AddressInfo).port;
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        acme: {
          baseUrl: `http://127.0.0.1:${upstreamPort}/v4`,
          api: "openai-completions",
          apiKey: REAL,
          models: [{ id: MODEL }],
        },
      },
    }),
  );
  const script = join(dir, "script.json");
  writeFileSync(script, "{}");
  const { logger, lines } = captureLogger();
  const clock = createSystemClock();
  const bed: Bed = {
    link: undefined as unknown as RelayLink,
    lines,
    upstream,
    script,
    hold: (on) => void (holding = on),
    policy: POLICY,
  };
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: dir,
    LANG: "C.UTF-8",
    // What the owner's shell may hold, and the relay must never inherit.
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    GH_TOKEN: "ghp_secret",
    ...over.daemonEnv,
  };
  const link = createRelayLink({
    fork: () =>
      forkRelay({
        entry: MAIN,
        execArgv: EXEC_ARGV,
        listen: relayListenOf(true),
        env: relayEnv(env, agentDir, script),
        clock,
        logger,
      }),
    clock,
    logger,
    policyOf: async () => bed.policy,
    claudeToken: () => null,
  });
  (bed as { link: RelayLink }).link = link;
  cleanups.push(() => link.stop());
  await link.start();
  await link.whenReady();
  return bed;
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
const chat = (model = MODEL) => JSON.stringify({ model, stream: true, messages: [] });
const grant = (bed: Bed, over: { address?: string; key?: string; launchId?: string } = {}) =>
  bed.link.grant({
    launchId: over.launchId ?? LAUNCH,
    box: AGENT,
    relayKey: over.key ?? KEY,
    address: over.address ?? "127.0.0.1",
  });
/** Tries until `done` (the relay handles its IPC commands in order, on its own schedule): a condition wait with a deadline. */
const until = <T>(attempt: () => Promise<T>, done: (value: T) => boolean): Promise<T> =>
  vi.waitFor(
    async () => {
      const value = await attempt();
      if (!done(value)) throw new Error("not yet");
      return value;
    },
    { timeout: 20_000, interval: 20 },
  );
const port = (bed: Bed): number => {
  const found = bed.link.port();
  if (found === null) throw new Error("the relay is not ready");
  return found;
};

describe("the relay child the daemon forks", () => {
  it("lets the launch's key through for its own model and refuses another (grant, then policy)", async () => {
    const bed = await start();
    grant(bed);
    const reply = await until(
      () => post(port(bed), chat()),
      (answer) => answer.status === 200,
    );
    expect(reply.text).toBe('data: {"delta":"he"}\n\ndata: [DONE]\n\n');
    expect(bed.upstream).toHaveLength(1);
    expect(bed.upstream[0]?.url).toBe("/v4/chat/completions");
    // The provider's own key went upstream; the relay key never did.
    expect(bed.upstream[0]?.headers.authorization).toBe(`Bearer ${REAL}`);
    expect(JSON.stringify(bed.upstream[0]?.headers)).not.toContain(KEY);
    const other = await post(port(bed), chat("not-allowed"));
    expect(other.status).toBe(403);
    expect(JSON.parse(other.text)).toEqual({ error: "model" });
    // A body with two `model` keys names no model the policy would accept (T12 carry).
    const twice = await post(port(bed), '{"model":"not-allowed","model":"m-1","messages":[]}');
    expect(JSON.parse(twice.text)).toEqual({ error: "model" });
    expect(bed.upstream).toHaveLength(1);
  }, 60_000);

  it("refuses a key granted to another address, and accepts it from the address it was granted to", async () => {
    const bed = await start();
    const OTHER = "cd".repeat(32);
    grant(bed, { address: "10.213.0.9" });
    // The relay handles its commands in order: once this second launch is served, the first grant has been taken.
    grant(bed, { launchId: "b".repeat(32), key: OTHER, address: "127.0.0.1" });
    await until(
      () => post(port(bed), chat(), OTHER),
      (answer) => answer.status === 200,
    );
    const reply = await post(port(bed), chat());
    expect(reply.status).toBe(403);
    expect(JSON.parse(reply.text)).toEqual({ error: "key" });
    expect(bed.upstream).toHaveLength(1);
    // The positive control: the same launch granted again from the caller's own address is served with the same key.
    grant(bed, { address: "127.0.0.1" });
    await until(
      () => post(port(bed), chat()),
      (answer) => answer.status === 200,
    );
    expect(bed.upstream).toHaveLength(2);
  }, 60_000);

  it("refuses the key after a revoke, and a revoke ends a stream that is running (T12 carry)", async () => {
    const bed = await start();
    grant(bed);
    await until(
      () => post(port(bed), chat()),
      (answer) => answer.status === 200,
    );
    bed.hold(true);
    const ended = new Promise<"end" | "error">((resolve) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: port(bed),
          method: "POST",
          path: "/acme/chat/completions",
          headers: {
            host: "llm.internal:7842",
            authorization: `Bearer ${KEY}`,
            "content-length": String(Buffer.byteLength(chat())),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve("end"));
          res.on("error", () => resolve("error"));
          res.on("close", () => resolve("error"));
        },
      );
      req.on("error", () => resolve("error"));
      req.end(chat());
    });
    await vi.waitFor(() => expect(bed.upstream).toHaveLength(2), { timeout: 10_000 });
    bed.link.revoke(LAUNCH);
    expect(await ended).toBe("error");
    const after = await until(
      () => post(port(bed), chat()),
      (answer) => answer.status === 403,
    );
    expect(JSON.parse(after.text)).toEqual({ error: "key" });
  }, 60_000);

  it("is restarted when it is killed, and the grant still works (RT-36, M-no-replay)", async () => {
    const bed = await start();
    grant(bed);
    const first = port(bed);
    await until(
      () => post(first, chat()),
      (answer) => answer.status === 200,
    );
    const [pid] = pidsWithEnv(`PAP_TEST_PROVIDER_SCRIPT=${bed.script}`);
    expect(pid).toBeGreaterThan(1);
    process.kill(pid as number, "SIGKILL");
    await vi.waitFor(() => expect(bed.link.port()).toBeNull(), { timeout: 10_000 });
    await bed.link.whenReady();
    const reply = await until(
      () => post(port(bed), chat()),
      (answer) => answer.status === 200,
    );
    expect(reply.status).toBe(200);
    expect(pidsWithEnv(`PAP_TEST_PROVIDER_SCRIPT=${bed.script}`)).not.toContain(pid);
    // The policy was replayed too: another model is still refused.
    expect(JSON.parse((await post(port(bed), chat("not-allowed"))).text)).toEqual({ error: "model" });
  }, 60_000);

  it("listens on loopback only, never a wildcard, and its environment is PI_CODING_AGENT_DIR plus the allowlist (AVM-P10)", async () => {
    const bed = await start();
    const listening = readFileSync("/proc/net/tcp", "utf8")
      .split("\n")
      .slice(1)
      .map((row) => row.trim().split(/\s+/))
      .filter(
        (cols) =>
          cols[3] === "0A" && cols[1]?.endsWith(`:${port(bed).toString(16).toUpperCase().padStart(4, "0")}`),
      )
      .map((cols) => cols[1]?.split(":")[0]);
    expect(listening).toEqual(["0100007F"]);
    const [pid] = pidsWithEnv(`PAP_TEST_PROVIDER_SCRIPT=${bed.script}`);
    const environ = readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").filter(Boolean);
    const names = environ.map((entry) => entry.split("=")[0]);
    expect(names).toContain("PI_CODING_AGENT_DIR");
    for (const forbidden of ["NODE_TLS_REJECT_UNAUTHORIZED", "ANTHROPIC_API_KEY", "GH_TOKEN"])
      expect(names).not.toContain(forbidden);
    expect(
      names.filter(
        (name) =>
          ![
            "PATH",
            "HOME",
            "LANG",
            "TERM",
            "PI_CODING_AGENT_DIR",
            "PAP_TEST_PROVIDER_SCRIPT",
            "NODE_CHANNEL_FD",
            "NODE_CHANNEL_SERIALIZATION_MODE",
          ].includes(name as string),
      ),
    ).toEqual([]);
  }, 60_000);

  it("keeps the relay key and the provider's key out of the daemon's log", async () => {
    const bed = await start();
    grant(bed);
    await until(
      () => post(port(bed), chat()),
      (answer) => answer.status === 200,
    );
    await post(port(bed), chat("not-allowed"));
    const text = JSON.stringify(bed.lines);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(REAL);
    expect(bed.lines.some((line) => line.msg === "relay_log")).toBe(true);
  }, 60_000);
});
