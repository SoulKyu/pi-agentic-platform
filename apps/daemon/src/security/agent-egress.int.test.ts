import { execFileSync } from "node:child_process";
import { createSocket } from "node:dgram";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput, type EgressStatus, type PapError, type SessionStreamEvent } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSystemClock } from "../kernel/clock.ts";
import { silentLogger } from "../kernel/logger.ts";
import { createSandboxProbe } from "../kernel/sandbox/probe.ts";
import { createNetworkRequest } from "../modules/agents/index.ts";
import { probePython } from "../modules/egress/python-probe.ts";
import { connectLine, denyOf, exchange } from "../modules/egress/testing/bed.ts";
import { loopbackEgress } from "../modules/egress/testing/port.ts";
import { BYPASS, FETCH } from "../modules/egress/testing/worker-scripts.ts";
import { createPlatformPort } from "../modules/platform/index.ts";
import { createIntBed, type IntBed, type Subscription } from "../modules/sessions/testing/int-bed.ts";
import { disposeParts, parts } from "../testing/compose-m11-parts.ts";
import { testCaller } from "../testing/caller.ts";
import { selfSignedCertificate } from "../testing/self-signed.ts";

// Networked agent sessions behind the daemon's egress wiring: a real worker, a real bwrap and python, and a proxy that reaches
// local origins only (W5-R50: no public address, no real host name, nothing leaves this machine). CI must provide bwrap and
// python3; locally the file skips with one line.
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    if (host === "mapped.test") return [{ address: "127.0.0.1", family: 4 }];
    throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  },
}));

function bwrapWorks(): boolean {
  try {
    execFileSync("/usr/bin/bwrap", ["--ro-bind", "/", "/", "--unshare-pid", "--", "/bin/true"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
const python: EgressStatus = await probePython({ clock: createSystemClock() });
const usable = bwrapWorks() && python.usable;
if (!usable && process.env["CI"]) throw new Error("agent-egress.int.test: CI must provide bwrap and python3");
if (!usable)
  console.warn("agent-egress.int.test: skipped: no usable /usr/bin/bwrap or python3 on this machine");

const ID = "atlas-1a2b";
const bash = (command: string, id: string) => ({ toolCalls: [{ name: "bash", args: { command }, id }] });
const FETCHED = (name: string) => `python3 fetch.py ${name} > ${name.replace(/\W+/g, "_")}.out 2>&1`;

interface Origins {
  readonly http: number;
  readonly https: number;
  readonly httpSeen: string[];
  readonly tcp: { port: number; seen: number };
  readonly udp: { port: number; seen: number };
  close(): Promise<void>;
}
const listening = (server: {
  listen(port: number, host: string, cb: () => void): unknown;
  address(): unknown;
}) =>
  new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });

async function startOrigins(dir: string): Promise<Origins> {
  const certs = selfSignedCertificate(dir);
  const httpSeen: string[] = [];
  const http = createHttpServer((req, res) => (httpSeen.push(req.url ?? ""), res.end("origin http")));
  const https = createHttpsServer(
    { cert: readFileSync(certs.cert), key: readFileSync(certs.key) },
    (_req, res) => res.end("origin https"),
  );
  const tcp = { port: 0, seen: 0 };
  const tcpServer = createTcpServer((socket) => ((tcp.seen += 1), socket.destroy()));
  const udp = { port: 0, seen: 0 };
  const udpServer = createSocket("udp4");
  udpServer.on("message", () => void (udp.seen += 1));
  tcp.port = await listening(tcpServer);
  udp.port = await new Promise<number>((resolve) =>
    udpServer.bind(0, "127.0.0.1", () => resolve(udpServer.address().port)),
  );
  return {
    http: await listening(http),
    https: await listening(https),
    httpSeen,
    tcp,
    udp,
    close: async () => {
      http.closeAllConnections();
      https.closeAllConnections();
      for (const server of [http, https, tcpServer]) await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => udpServer.close(() => resolve(undefined)));
    },
  };
}

let bed: IntBed;
let origins: Origins;
let egressDir: string;
afterEach(async () => {
  // Each test builds its own world; one that built none (the composition test) leaves nothing to dispose.
  const [done, held, dir] = [bed, origins, egressDir];
  bed = undefined as unknown as IntBed;
  origins = undefined as unknown as Origins;
  egressDir = "";
  await done?.dispose();
  await held?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  disposeParts();
});

interface WorldOptions {
  input?: object;
  status?: EgressStatus;
}
/** The sessions module of the bed with an agent whose profile is networked, the egress over local origins and the platform tools. */
async function world(options: WorldOptions = {}) {
  egressDir = realpathSync(mkdtempSync(join(tmpdir(), "pap-egx-")));
  origins = await startOrigins(egressDir);
  bed = await createIntBed({ steps: [{ text: "placeholder" }] });
  const home = join(bed.papHome, "agents", ID);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "fetch.py"), FETCH);
  writeFileSync(join(home, "bypass.py"), BYPASS);
  const probe = createSandboxProbe({ override: undefined, clock: createSystemClock(), logger: silentLogger });
  await probe.recheck();
  const egress = loopbackEgress({
    dir: egressDir,
    names: {
      "allowed.test": { 80: origins.http },
      "trusted.test": { 443: origins.https },
      "unlisted.test": { 80: origins.http },
    },
    status: options.status ?? python,
  });
  const input = AgentInput.parse({
    name: "Atlas",
    mode: "full-access",
    preset: "full",
    sandbox: { required: true, network: true },
    allowHosts: ["allowed.test", "trusted.test"],
    trustedSources: ["trusted.test"],
    ...options.input,
  });
  const platform = createPlatformPort({
    sessions: bed.sessions,
    audit: { append: () => {}, reserve: () => true },
    clock: createSystemClock(),
    logger: silentLogger,
    readOnly: false,
  });
  platform.register(
    "network.request",
    createNetworkRequest({ grants: bed.sessions.hostGrants, clock: createSystemClock() }),
  );
  bed.sessions.setAgentPorts({
    platform,
    agents: {
      profileOf: (ownerId, agentId) =>
        ownerId === "u1" && agentId === ID ? { input, name: "Atlas", quarantined: false } : null,
      probe,
      egress,
    },
  });
  return { home, egress };
}
const script = (steps: object[]) => writeFileSync(join(bed.root, "script.json"), JSON.stringify({ steps }));
/** A start that fails says what the worker printed as it died: the rare `worker_failed` at start is then diagnosable. */
const thread = () =>
  bed.sessions.agentSessions
    .createAgentSession({ ownerId: "u1", agentId: ID, role: "thread" })
    .catch((error: unknown) => {
      const tail = bed.exits.map((exit) => `${JSON.stringify(exit.exit)} ${exit.outputTail}`).join("\n---\n");
      throw tail ? new Error(`${String(error)}\nworker output:\n${tail}`, { cause: error }) : error;
    });
const read = (path: string) => readFileSync(path, "utf8");
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: PapError) => error.code,
  );
const taintedIn = (sub: Subscription) =>
  sub
    .events()
    .some((event) => event.kind === "policy" && (event as { policy: { tainted: boolean } }).policy.tainted);
const idleSince = (sub: Subscription, before: number) =>
  vi.waitFor(
    () => {
      const statuses = sub
        .events()
        .slice(before)
        .flatMap((event) => (event.kind === "status" ? [event.status] : []));
      if (!statuses.includes("running") || statuses.lastIndexOf("idle") <= statuses.indexOf("running"))
        throw new Error("still running");
    },
    { timeout: 30_000 },
  );
async function run(sessionId: string, text = "go") {
  const sub = await bed.subscribe(sessionId);
  const before = sub.events().length;
  await bed.rpc["sessions.prompt"]({ sessionId, text }, bed.ctx);
  return { sub, before, settled: () => idleSince(sub, before) };
}
const isCard = (event: SessionStreamEvent) => event.kind === "dialog_open";

describe.skipIf(!usable)("a networked agent session behind the daemon's egress wiring (M11 XS2)", () => {
  it("reaches a listed test host over plain HTTP, and the thread is tainted", async () => {
    const { home } = await world();
    script([bash(FETCHED("http://allowed.test/x"), "b1"), { text: "done" }]);
    const { sessionId } = await thread();
    const { sub, settled } = await run(sessionId);
    await settled();
    expect(read(join(home, "http_allowed_test_x.out"))).toContain("200 origin http");
    expect(origins.httpSeen).toEqual(["/x"]);
    expect(taintedIn(sub)).toBe(true);
  }, 90_000);

  it("keeps a trusted source over CONNECT 443 untainted", async () => {
    const { home } = await world();
    script([bash(FETCHED("https://trusted.test/"), "b1"), { text: "done" }]);
    const { sessionId } = await thread();
    const { sub, settled } = await run(sessionId);
    await settled();
    expect(read(join(home, "https_trusted_test_.out"))).toContain("200 origin https");
    expect(taintedIn(sub)).toBe(false);
  }, 90_000);

  it("refuses an unlisted host; the owner's browser answers the network_request card; the retry reaches it; a reset ends the grant", async () => {
    const { home } = await world();
    script([
      bash(FETCHED("http://unlisted.test/x"), "b1"),
      { toolCalls: [{ name: "network_request", args: { host: "unlisted.test" }, id: "n1" }] },
      bash("python3 fetch.py http://unlisted.test/y > retry.out 2>&1", "b2"),
      { text: "done" },
    ]);
    const { sessionId } = await thread();
    const { sub, settled } = await run(sessionId);
    const card = await sub.waitFor(isCard);
    const dialogId = (card as { dialog: { id: string; answers?: string[] } }).dialog.id;
    expect((card as { dialog: { answers?: string[] } }).dialog.answers).toEqual(["deny", "host"]);
    expect(read(join(home, "http_unlisted_test_x.out"))).toContain("403 pap egress proxy: unlisted.test");
    expect(origins.httpSeen).toEqual([]);
    // A token cannot answer that card; it stays open for the owner.
    const token = { ...bed.ctx, caller: testCaller({ kind: "token", credentialId: "tok1" }) };
    expect(
      await codeOf(
        bed.rpc["sessions.respondDialog"]({ sessionId, dialogId, response: { answer: "host" } }, token),
      ),
    ).toBe("forbidden");
    expect(bed.sessions.hostGrants.of(sessionId)).toEqual([]);
    await bed.rpc["sessions.respondDialog"]({ sessionId, dialogId, response: { answer: "host" } }, bed.ctx);
    await settled();
    expect(bed.sessions.hostGrants.of(sessionId)).toEqual(["unlisted.test"]);
    expect(read(join(home, "retry.out"))).toContain("200 origin http");
    expect(origins.httpSeen).toEqual(["/y"]);

    // Reset: the thread is archived, its grants end, and the new thread is refused again.
    await bed.rpc["sessions.mark"]({ sessionId, change: { kind: "archive" } }, bed.ctx);
    expect(bed.sessions.hostGrants.of(sessionId)).toEqual([]);
    script([bash("python3 fetch.py http://unlisted.test/z > again.out 2>&1", "b1"), { text: "done" }]);
    const fresh = await thread();
    const next = await run(fresh.sessionId);
    await next.settled();
    expect(read(join(home, "again.out"))).toContain("403 pap egress proxy: unlisted.test");
    expect(origins.httpSeen).toEqual(["/y"]);
  }, 120_000);

  it("has no way out that is not the proxy: the listeners on this machine's loopback saw nothing", async () => {
    const { home } = await world();
    const { tcp, udp, http } = origins;
    script([
      bash(`python3 bypass.py ${tcp.port} ${udp.port} ${http} > bypass.out 2>&1`, "b1"),
      { text: "done" },
    ]);
    const { sessionId } = await thread();
    const { settled } = await run(sessionId);
    await settled();
    const seen = JSON.parse(read(join(home, "bypass.out")).split("\n")[0] ?? "{}") as Record<string, unknown>;
    expect(seen).toMatchObject({ tcp: expect.stringMatching(/Error$/), dns: "failed", interfaces: ["lo"] });
    expect([tcp.seen, udp.seen, origins.httpSeen]).toEqual([0, 0, []]);
  }, 90_000);

  it("does not start when the interpreter of the forwarder is not usable (sandbox_unavailable)", async () => {
    await world({ status: { usable: false, python: null, reason: "no_python" } });
    expect(await codeOf(thread())).toBe("sandbox_unavailable");
    expect(await bed.rpc["sessions.list"]({}, bed.ctx)).toMatchObject({ sessions: [] });
    expect(bed.exits).toEqual([]);
  });

  it("an agent with the network off starts without the proxy, whatever the proxy's status", async () => {
    const { home } = await world({
      status: { usable: false, python: null, reason: "no_python" },
      input: { sandbox: { required: true, network: false } },
    });
    script([bash("ls /run > run.out 2>&1", "b1"), { text: "done" }]);
    const { sessionId } = await thread();
    const { settled } = await run(sessionId);
    await settled();
    expect(read(join(home, "run.out"))).toBe("");
    expect(existsSync(join(egressDir, "0.s"))).toBe(false);
  }, 90_000);
});

describe.skipIf(!usable)("the production composition of the proxy (M11R244)", () => {
  it("refuses a name that maps to the host's loopback, whatever the agent's list allows", async () => {
    const composed = parts({ realEgress: true });
    const bound = composed.sessions.setAgentPorts.mock.calls
      .map(
        ([ports]) =>
          (ports as { agents?: { egress?: import("../modules/egress/index.ts").EgressPort } }).agents,
      )
      .find((agents) => agents?.egress !== undefined);
    const egress = bound?.egress;
    if (egress === undefined) throw new Error("compose bound no egress module");
    await egress.ready();
    expect(egress.status().usable).toBe(true);
    const opened = await egress.openCommand({
      ownerId: "u1",
      agentId: "atlas-1a2b",
      sessionId: "s1",
      hosts: ["mapped.test"],
      trustedSources: [],
      grants: () => [],
    });
    if (!("socket" in opened)) throw new Error("not opened");
    expect(denyOf(await exchange(opened.socket, connectLine("mapped.test:443")))).toBe("blocked_ip");
    await egress.dropSession("s1");
    expect(existsSync(opened.socket)).toBe(false);
  });
});
