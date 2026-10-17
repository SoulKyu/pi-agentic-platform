import { type ChildProcess, execFileSync, fork } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createSocket } from "node:dgram";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type EgressStatus, PolicyRules, type SandboxSpec } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { selfSignedCertificate } from "../../testing/self-signed.ts";
import { writeForwarder } from "./forwarder.ts";
import { type CommandListener, createProxy } from "./index.ts";
import { probePython } from "./python-probe.ts";
import { scopeOf } from "./testing/bed.ts";
import { loopbackBed } from "./testing/loopback.ts";
import { BYPASS, FETCH } from "./testing/worker-scripts.ts";

// The real worker (pi-host) behind the real bwrap, python and egress proxy, over local origins only. CI must provide
// them; locally the file skips with one line. No test here names an address or a host that is not on this machine (W5-R50).
const BWRAP = "/usr/bin/bwrap";
function bwrapWorks(): boolean {
  try {
    execFileSync(BWRAP, ["--ro-bind", "/", "/", "--unshare-pid", "--", "/bin/true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const python: EgressStatus = await probePython({ clock: createSystemClock() });
const usable = bwrapWorks() && python.usable;
if (!usable && process.env["CI"]) throw new Error("host.egress.int.test: CI must provide bwrap and python3");
if (!usable)
  console.warn("host.egress.int.test: skipped: no usable /usr/bin/bwrap or python3 on this machine");

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const PI_HOST_MAIN = join(REPO, "packages/pi-host/src/main.ts");
const NETWORK_GUARD = join(REPO, "packages/pi-host/src/testing/network-guard.ts");
const CACHE = join(REPO, "node_modules/.cache");

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
  const tcpServer = createTcpServer((socket) => {
    tcp.seen += 1;
    socket.destroy();
  });
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

type Record_ = { type: string } & Record<string, unknown>;
const commandId = (index: number) => `call-${index}`;
const outputOf = (end: Record_ | undefined): string =>
  ((end?.["result"] as { content?: Array<{ text?: string }> } | undefined)?.content ?? [])
    .map((part) => part.text ?? "")
    .join("");

describe.skipIf(!usable)("a networked agent shell behind the real egress proxy (M11 XS)", () => {
  let root: string;
  let base: string;
  let origins: Origins;
  let workers: ChildProcess[];
  let listeners: CommandListener[];
  beforeEach(async () => {
    mkdirSync(CACHE, { recursive: true });
    base = realpathSync(mkdtempSync(join(CACHE, "pap-egress-host-")));
    root = realpathSync(mkdtempSync(join(tmpdir(), "pap-egress-run-")));
    origins = await startOrigins(root);
    workers = [];
    listeners = [];
  });
  afterEach(async () => {
    for (const worker of workers) {
      const pid = worker.pid ?? 0;
      if (pid <= 1) continue;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    for (const listener of listeners) await listener.close();
    await origins.close();
    rmSync(base, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  /** Runs each command as its own scripted `bash` call of a fresh worker; the daemon end answers its egress records. */
  async function runCommands(commands: string[], options: { network?: boolean } = {}) {
    const network = options.network ?? true;
    const ownerHome = join(base, "home");
    const papHome = join(ownerHome, ".pap");
    const home = join(papHome, "agents", "atlas-1a2b");
    for (const dir of [home, join(root, "agent"), join(root, "run")]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(home, "fetch.py"), FETCH);
    writeFileSync(join(home, "bypass.py"), BYPASS);
    const names = {
      "allowed.test": { 80: origins.http },
      "trusted.test": { 443: origins.https },
      "other.test": { 443: origins.https },
    };
    const proxy = createProxy({
      clock: createSystemClock(),
      logger: silentLogger,
      ...loopbackBed(names),
    });
    const spec: SandboxSpec = {
      bwrap: BWRAP,
      view: "host",
      home,
      writable: home,
      hide: [ownerHome, "/var/log", "/var/tmp"],
      network,
      egress: network
        ? { python: python.python ?? "/usr/bin/python3", forwarder: writeForwarder(root) }
        : null,
    };
    writeFileSync(
      join(root, "script.json"),
      JSON.stringify({
        steps: [
          ...commands.map((command, index) => ({
            toolCalls: [{ name: "bash", args: { command }, id: commandId(index) }],
          })),
          { text: "done" },
        ],
      }),
    );
    const policy = PolicyRules.parse({
      profile: "agent-thread",
      approvalMode: "full-access",
      agentHome: home,
      sandbox: { required: true, network },
      allowHosts: ["allowed.test", "other.test"],
      autonomy: { hosts: ["allowed.test", "other.test"] },
      trustedSources: ["trusted.test"],
    });
    const worker = fork(PI_HOST_MAIN, [], {
      cwd: home,
      env: {
        PATH: process.env["PATH"],
        LANG: "C.UTF-8",
        PAP_TEST_PROVIDER: "1",
        HOME: join(root, "home"),
        PI_CODING_AGENT_DIR: join(root, "agent"),
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        PI_SKIP_VERSION_CHECK: "1",
      },
      execArgv: [
        "--conditions=development",
        "--disable-warning=ExperimentalWarning",
        "--import",
        NETWORK_GUARD,
      ],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: true,
    });
    workers.push(worker);
    const stderr: string[] = [];
    worker.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
    worker.stdout?.resume();
    const records: Record_[] = [];
    const open = new Map<string, CommandListener>();
    const scope = scopeOf({ hosts: ["allowed.test", "other.test"], trustedSources: ["trusted.test"] });
    worker.on("message", (record: Record_) => {
      records.push(record);
      const id = String(record["id"]);
      if (record.type === "egress_open") {
        void proxy.listen(join(root, "run", `${id}.s`), scope).then((listener) => {
          listeners.push(listener);
          open.set(id, listener);
          worker.send({ type: "egress_opened", id, socket: listener.path, reason: null });
        });
      } else if (record.type === "egress_close") {
        void open
          .get(id)
          ?.close()
          .then((report) => worker.send({ type: "egress_report", id, ...report }));
      }
    });
    const settled = new Promise<void>((resolve, reject) => {
      const poll = (record: Record_) => record.type === "agent_settled" && resolve();
      worker.on("message", poll);
      worker.once("exit", () => reject(new Error(`the worker exited: ${stderr.join("")}`)));
    });
    worker.send({
      type: "init",
      cwd: home,
      agentDir: join(root, "agent"),
      papHome,
      umask: 0o022,
      policy,
      testProviderScript: join(root, "script.json"),
      sandbox: spec,
      agent: { id: "atlas-1a2b", name: "Atlas", role: "test" },
    });
    await vi.waitFor(() => expect(records.some((record) => record.type === "ready")).toBe(true), {
      timeout: 30_000,
    });
    worker.send({ type: "prompt", id: "p1", message: "go" });
    await settled;
    const rows = records
      .filter((record) => record.type === "audit")
      .map(
        (record) =>
          record["entry"] as {
            kind: string;
            toolCallId?: string;
            external?: boolean;
            stages: Array<Record<string, string>>;
          },
      )
      .filter((entry) => entry.kind === "result");
    return {
      home,
      records,
      output: (index: number) =>
        outputOf(
          records.find(
            (record) => record.type === "tool_execution_end" && record["toolCallId"] === commandId(index),
          ),
        ),
      row: (index: number) => rows.find((entry) => entry.toolCallId === commandId(index)),
      tainted: () => records.some((record) => record.type === "taint"),
    };
  }

  it("carries plain HTTP to a listed host: output, a report and a tainted thread", async () => {
    const run = await runCommands(["python3 fetch.py http://allowed.test/x"]);
    expect(run.output(0)).toContain("200 origin http");
    expect(origins.httpSeen).toEqual(["/x"]);
    expect(run.tainted()).toBe(true);
    expect(run.row(0)).toMatchObject({
      external: true,
      stages: [{ stage: "06" }, { stage: "07", reason: "egress: untrusted host reached" }],
    });
  }, 90_000);

  it("keeps a trusted source over CONNECT 443 plain: untainted, with a stage 07 pass row", async () => {
    const run = await runCommands(["python3 fetch.py https://trusted.test/"]);
    expect(run.output(0)).toContain("200 origin https");
    expect(run.tainted()).toBe(false);
    expect(run.row(0)).toMatchObject({
      external: false,
      stages: [{ stage: "06" }, { stage: "07", outcome: "pass", reason: "egress: trusted sources only" }],
    });
  }, 90_000);

  it("taints for a listed host that is not a trusted source, even over CONNECT 443", async () => {
    const run = await runCommands(["python3 fetch.py https://other.test/"]);
    expect(run.output(0)).toContain("200 origin https");
    expect(run.tainted()).toBe(true);
  }, 90_000);

  it("refuses a host off the list with the proxy's 403, appends the line and does not taint", async () => {
    const run = await runCommands(["python3 fetch.py http://unlisted.test/"]);
    expect(run.output(0)).toContain("403 pap egress proxy: unlisted.test is not on this agent's host list");
    expect(run.output(0)).toContain(
      `[pap] The egress proxy refused: unlisted.test (not on this agent's host list). In this thread, ask the owner with network_request {"host": "unlisted.test"}.`,
    );
    expect(origins.httpSeen).toEqual([]);
    expect(run.tainted()).toBe(false);
    expect(run.row(0)).toMatchObject({ stages: [{ stage: "06" }, { stage: "07", outcome: "pass" }] });
  }, 90_000);

  it("does not taint a command that uses no network, and leaves no forwarder behind", async () => {
    const run = await runCommands(["echo hi", "python3 fetch.py http://unlisted.test/"]);
    expect(run.output(0)).toBe("hi\n");
    expect(run.tainted()).toBe(false);
    expect(run.row(0)).toMatchObject({
      stages: [{ stage: "06" }, { stage: "07", reason: "egress: no network used" }],
    });
    await vi.waitFor(
      () => {
        // Only this test's own forwarders, orphans included (they are reparented, so no tree walk finds them): the sandbox
        // environment carries HOME=<this test's agent home>, which no other test shares.
        const marker = `HOME=${run.home}\0`;
        const found = readdirSync("/proc")
          .filter((name) => /^\d+$/.test(name))
          .filter((name) => {
            try {
              return (
                readFileSync(`/proc/${name}/cmdline`, "utf8").includes("/run/pap-fwd.py") &&
                readFileSync(`/proc/${name}/environ`, "utf8").includes(marker)
              );
            } catch {
              return false;
            }
          });
        expect(found).toEqual([]);
      },
      { timeout: 10_000 },
    );
  }, 90_000);

  it("has no way out that is not the proxy: direct sockets, UDP, DNS, NO_PROXY, a SOCKS setting, other interfaces", async () => {
    const { tcp, udp, http } = origins;
    const run = await runCommands([
      `NO_PROXY='*' ALL_PROXY=socks5h://127.0.0.1:3128 python3 bypass.py ${tcp.port} ${udp.port} ${http}`,
    ]);
    const seen = JSON.parse(run.output(0).split("\n")[0] ?? "{}") as Record<string, unknown>;
    expect(seen).toEqual({
      tcp: expect.stringMatching(/Error$/),
      origin: expect.stringMatching(/Error$/),
      dns: "failed",
      interfaces: ["lo"],
      noproxy: expect.stringMatching(/Error$/),
      socks: "refused",
    });
    expect([tcp.seen, udp.seen, origins.httpSeen]).toEqual([0, 0, []]);
    expect(run.tainted()).toBe(false);
  }, 90_000);

  it("gives a network-off agent no proxy socket, and a networked one exactly the two files", async () => {
    const off = await runCommands(["ls /run"], { network: false });
    expect(off.output(0)).not.toContain("pap-egress.sock");
    expect(off.output(0)).not.toContain("pap-fwd.py");
    const on = await runCommands(["ls /run"]);
    expect(on.output(0).split("\n").filter(Boolean).sort()).toEqual(["pap-egress.sock", "pap-fwd.py"]);
  }, 120_000);
});
