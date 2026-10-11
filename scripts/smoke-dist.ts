// Post-build smoke test of the built artifacts: the compiled daemon (apps/daemon/dist/main.js) forking the compiled
// worker (packages/pi-host/dist/main.js), started without --conditions, so a dist that only works through the
// TypeScript sources fails here. It drives setup -> login -> /ws -> sessions.create -> prompt -> approve the dialog ->
// tool output -> agent_settled, then SIGTERM, and expects exit 0 with no worker left.
//
// Nothing leaves the machine and nothing touches the user's data: a temporary HOME, PAP_HOME and
// PI_CODING_AGENT_DIR, the scripted provider (no model is called), PI_OFFLINE=1 and a network guard preloaded into the
// daemon and, through its forwarded --import=, into every worker. Run it after `pnpm build`: `pnpm smoke`.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { cmdlineOf, descendantsOf, running, runningUnder } from "./smoke-proc.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const DAEMON = join(REPO, "apps/daemon/dist/main.js");
const PI_HOST = join(REPO, "packages/pi-host/dist/main.js");
const WEB_INDEX = join(REPO, "apps/web/dist/index.html");
// Plain TypeScript with node:net only: Node strips the types, so it needs no build.
const NETWORK_GUARD = join(REPO, "packages/pi-host/src/testing/network-guard.ts");
const PROTOCOL = 2;
const STEP_MS = 60_000;
const STOP_MS = 20_000;
const REAP_MS = 5_000;
const MARKER = "pap-smoke-ok";
const PASSWORD = "correct horse battery staple";
const SCRIPT = {
  steps: [
    { toolCalls: [{ name: "bash", args: { command: `echo ${MARKER}` }, id: "call-1" }] },
    { text: `The command printed ${MARKER}.` },
  ],
};

type Json = Record<string, unknown>;
const step = (message: string): void => console.log(`smoke: ${message}`);
const asJson = (value: unknown): Json => (typeof value === "object" && value !== null ? (value as Json) : {});

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${what}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

// node:http, because fetch may refuse to send an Origin header.
function http(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>((resolve, reject) => {
    const req = request(url, { method: init.method ?? "GET", headers: init.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
    req.setTimeout(STEP_MS, () => req.destroy(new Error(`${url} timed out`)));
    if (init.body) req.write(init.body);
    req.end();
  });
}

interface Daemon {
  readonly child: ChildProcess;
  readonly output: string[];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  line(msg: string): Promise<Json>;
}

function startDaemon(env: NodeJS.ProcessEnv, port: number): Daemon {
  // No --conditions: this is the built daemon on its own. The guard reaches workers through PAP_TEST_WORKER_IMPORT.
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      `--import=${NETWORK_GUARD}`,
      DAEMON,
      "serve",
      "--port",
      String(port),
    ],
    { env, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  const output: string[] = [];
  const lines: Json[] = [];
  const watchers = new Set<() => void>();
  let pending = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
      const text = pending.slice(0, at);
      pending = pending.slice(at + 1);
      output.push(text);
      try {
        lines.push(asJson(JSON.parse(text)));
      } catch {
        // A line that is not JSON stays in `output` for the failure report.
      }
    }
    for (const watcher of [...watchers]) watcher();
  });
  child.stderr?.on("data", (chunk: Buffer) => output.push(`stderr: ${chunk.toString("utf8").trimEnd()}`));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  return {
    child,
    output,
    exited,
    line: (msg) =>
      new Promise((resolve, reject) => {
        const gone = () => reject(new Error(`the daemon exited before it logged ${msg}`));
        const look = () => {
          const hit = lines.find((line) => line.msg === msg);
          if (!hit) return;
          watchers.delete(look);
          child.off("close", gone);
          resolve(hit);
        };
        child.once("close", gone);
        watchers.add(look);
        look();
      }),
  };
}

interface Session {
  call(method: string, params: Json, mutation?: boolean): Promise<unknown>;
  waitFor(match: (event: Json) => boolean, what: string): Promise<Json>;
  close(): void;
}

async function openSession(port: number, origin: string, cookie: string): Promise<Session> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?proto=${PROTOCOL}`, {
    headers: { origin, cookie },
  });
  const events: Json[] = [];
  const answers = new Map<number, (frame: Json) => void>();
  const watchers = new Set<() => void>();
  let hello: (frame: Json) => void = () => {};
  const greeted = new Promise<Json>((resolve) => (hello = resolve));
  let nextId = 0;
  // A socket that closes under a pending wait (the daemon died) ends it at once instead of at the step timeout.
  const closed = new Promise<never>((_, reject) =>
    socket.once("close", (code) => reject(new Error(`the socket closed (${code}) before the answer`))),
  );
  closed.catch(() => undefined);
  socket.on("message", (data) => {
    const frame = asJson(JSON.parse(String(data)));
    if ("protocol" in frame) hello(frame);
    else if ("sub" in frame) {
      events.push(asJson(frame.event));
      for (const watcher of [...watchers]) watcher();
    } else answers.get(Number(frame.id))?.(frame);
  });
  await within(
    new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
      socket.once("unexpected-response", (_req, res) => reject(new Error(`/ws answered ${res.statusCode}`)));
    }),
    STEP_MS,
    "the websocket to open",
  );
  const first = await within(greeted, STEP_MS, "the hello frame");
  if (first.protocol !== PROTOCOL)
    throw new Error(`protocol ${String(first.protocol)}, expected ${PROTOCOL}`);
  return {
    async call(method, params, mutation = false) {
      const id = ++nextId;
      const reply = new Promise<Json>((resolve) => answers.set(id, resolve));
      socket.send(JSON.stringify({ id, method, params, ...(mutation ? { commandId: randomUUID() } : {}) }));
      const frame = await within(Promise.race([reply, closed]), STEP_MS, `the answer to ${method}`);
      if (frame.ok !== true) throw new Error(`${method} failed: ${JSON.stringify(frame)}`);
      return frame.result;
    },
    waitFor: (match, what) =>
      within(
        Promise.race([
          new Promise<Json>((resolve) => {
            const look = () => {
              const hit = events.find(match);
              if (!hit) return;
              watchers.delete(look);
              resolve(hit);
            };
            watchers.add(look);
            look();
          }),
          closed,
        ]),
        STEP_MS,
        what,
      ),
    close: () => socket.close(),
  };
}

const isPi =
  (type: string) =>
  (event: Json): boolean =>
    event.kind === "pi" && asJson(event.event).type === type;

async function drive(daemon: Daemon, port: number, work: string, userHome: string): Promise<void> {
  const origin = `http://localhost:${port}`;
  const base = `http://127.0.0.1:${port}`;
  const listening = await within(daemon.line("listening"), STEP_MS, "the daemon to listen");
  step(`daemon listening on ${String(listening.url)}`);
  const health = await http(`${base}/healthz`);
  if (health.status !== 200) throw new Error(`/healthz answered ${health.status}`);
  const page = await http(`${base}/`);
  if (page.status !== 200 || !String(page.headers["content-type"]).startsWith("text/html"))
    throw new Error(`/ gave ${page.status}: the web build is missing from the dist`);
  step("/healthz and the built web page answer");

  const setupUrl = String((await within(daemon.line("setup_url"), STEP_MS, "the setup address")).url);
  const token = new URL(setupUrl).hash.replace("#token=", "");
  const setup = await http(`${base}/auth/setup`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ token, username: "owner", password: PASSWORD }),
  });
  if (setup.status !== 201) throw new Error(`/auth/setup answered ${setup.status}`);
  const login = await http(`${base}/auth/login`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: PASSWORD }),
  });
  const setCookie = login.headers["set-cookie"];
  const cookie = ((Array.isArray(setCookie) ? setCookie[0] : setCookie) ?? "").split(";")[0] ?? "";
  if (login.status !== 200 || !cookie.startsWith("pap_session="))
    throw new Error(`login answered ${login.status}`);
  step("owner created, signed in");

  const session = await openSession(port, origin, cookie);
  try {
    const created = asJson(await session.call("sessions.create", { cwd: work }, true));
    const sessionId = String(created.sessionId);
    await session.call("subscribe.session", { sessionId });
    await session.waitFor((event) => event.kind === "snapshot", "the snapshot");
    step(`session ${sessionId} created and subscribed`);
    await session.call("sessions.prompt", { sessionId, text: "Run the check" }, true);
    const dialog = asJson(
      (await session.waitFor((event) => event.kind === "dialog_open", "the approval card")).dialog,
    );
    if (!String(dialog.message).includes(`echo ${MARKER}`))
      throw new Error(`the approval card does not show the command: ${JSON.stringify(dialog)}`);
    await session.call(
      "sessions.respondDialog",
      { sessionId, dialogId: String(dialog.id), response: { answer: "once" } },
      true,
    );
    // The stream keeps the tool's output off `tool_execution_end` (spec C §4.3): it arrives as the tool result message.
    const toolEnd = await session.waitFor(isPi("tool_execution_end"), "the tool end");
    if (asJson(toolEnd.event).isError === true)
      throw new Error(`the tool failed: ${JSON.stringify(toolEnd).slice(0, 500)}`);
    await session.waitFor(
      (event) =>
        isPi("message_end")(event) &&
        JSON.stringify(event).includes('"role":"toolResult"') &&
        JSON.stringify(event).includes(MARKER),
      `the tool result printing ${MARKER}`,
    );
    await session.waitFor(isPi("agent_settled"), "agent_settled");
    step("prompt -> approval -> tool output -> agent_settled");
  } finally {
    session.close();
  }

  const daemonPid = daemon.child.pid;
  if (daemonPid === undefined || daemonPid <= 1) throw new Error("the daemon has no process id of its own");
  const workers = descendantsOf(daemonPid);
  const hosts = workers.filter((pid) => cmdlineOf(pid).includes(PI_HOST));
  if (hosts.length === 0) throw new Error(`no worker running ${PI_HOST} was found under the daemon`);
  for (const pid of hosts) {
    if (!cmdlineOf(pid).includes(`--import=${NETWORK_GUARD}`))
      throw new Error(`worker ${pid} runs without the network guard`);
  }
  // The leftover check below must be able to see a worker, or it proves nothing.
  const visible = runningUnder(userHome);
  if (!workers.every((pid) => visible.includes(pid)))
    throw new Error("the process scan cannot see the workers");
  daemon.child.kill("SIGTERM");
  const exit = await within(daemon.exited, STOP_MS, "the daemon to stop on SIGTERM");
  if (exit.code !== 0) throw new Error(`the daemon exited with ${JSON.stringify(exit)}, expected code 0`);
  const deadline = Date.now() + REAP_MS;
  while (workers.some(running) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  const left = [...new Set([...workers.filter(running), ...runningUnder(userHome)])];
  if (left.length > 0) throw new Error(`processes left after the stop: ${left.join(", ")}`);
  step(`SIGTERM: exit 0, ${workers.length} worker process(es) gone`);
}

// What a failed or finished run must not leave behind: the daemon's descendants (workers lead groups of their own),
// anything still running under the run's HOME, and the daemon's own group. Pids at or below 1 are never signalled.
function killLeftovers(daemonPid: number | undefined, userHome: string | null): void {
  const own = daemonPid !== undefined && daemonPid > 1 ? daemonPid : null;
  const pids = [...(own ? descendantsOf(own) : []), ...(userHome ? runningUnder(userHome) : [])];
  for (const pid of pids) {
    if (pid <= 1 || pid === process.pid) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  if (own === null) return;
  try {
    process.kill(-own, "SIGKILL");
  } catch {
    // already gone
  }
}

async function main(): Promise<void> {
  if (process.platform !== "linux") throw new Error("the smoke test reads /proc: it runs on Linux only");
  for (const [what, path] of [
    ["the daemon build", DAEMON],
    ["the worker build", PI_HOST],
    ["the web build", WEB_INDEX],
  ] as const) {
    try {
      readFileSync(path);
    } catch {
      throw new Error(`${what} is missing (${path}): run pnpm build first`);
    }
  }
  let root: string | null = null;
  let userHome: string | null = null;
  let daemon: Daemon | null = null;
  try {
    root = mkdtempSync(join(tmpdir(), "pap-smoke-"));
    const home = join(root, "home");
    const agent = join(root, "agent");
    const work = join(root, "work");
    userHome = join(root, "user");
    for (const dir of [agent, work, userHome]) mkdirSync(dir);
    const script = join(root, "script.json");
    writeFileSync(script, JSON.stringify(SCRIPT));
    const port = await freePort();
    // Not the whole environment: nothing of the outer PI_*, PAP_* or credentials reaches the daemon or its workers.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      HOME: userHome,
      PAP_HOME: home,
      PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PAP_TEST_PROVIDER_SCRIPT: script,
      PAP_TEST_WORKER_IMPORT: NETWORK_GUARD,
    };
    daemon = startDaemon(env, port);
    await drive(daemon, port, work, userHome);
  } catch (error) {
    console.error(`smoke: ${error instanceof Error ? error.message : String(error)}`);
    if (daemon) console.error(`smoke: daemon output:\n${daemon.output.slice(-40).join("\n")}`);
    process.exitCode = 1;
  } finally {
    killLeftovers(daemon?.child.pid, userHome);
    if (root) rmSync(root, { recursive: true, force: true });
  }
  if (process.exitCode === undefined) step("ok");
}

main().catch((error: unknown) => {
  console.error(`smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
