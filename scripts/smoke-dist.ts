// Post-build smoke test of the built artifacts: the compiled daemon (apps/daemon/dist/main.js) forking the compiled
// worker (packages/pi-host/dist/main.js), started without --conditions, so a dist that only works through the
// TypeScript sources fails here. It drives setup -> login -> /ws -> sessions.create -> prompt -> approve the dialog ->
// tool output -> agent_settled, then SIGTERM, and expects exit 0 with no worker left.
//
// Nothing leaves the machine and nothing touches the user's data: a temporary HOME, PAP_HOME and
// PI_CODING_AGENT_DIR, the scripted provider (no model is called), PI_OFFLINE=1 and a network guard preloaded into the
// daemon and, through its forwarded --import=, into every worker. Run it after `pnpm build`: `pnpm smoke`.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkLanes } from "./smoke-lanes.ts";
import { checkModels } from "./smoke-models.ts";
import { checkPwa } from "./smoke-pwa.ts";
import { checkScannerAndSearch } from "./smoke-search.ts";
import { checkTerminal } from "./smoke-terminal.ts";
import {
  DAEMON,
  type Daemon,
  http,
  isPi,
  type Json,
  NETWORK_GUARD,
  openSession,
  REPO,
  STEP_MS,
  startDaemon,
  step,
  asJson,
  within,
  freePort,
} from "./smoke-lib.ts";
import { cmdlineOf, descendantsOf, running, runningUnder } from "./smoke-proc.ts";

const PI_HOST = join(REPO, "packages/pi-host/dist/main.js");
const WEB_INDEX = join(REPO, "apps/web/dist/index.html");
const STOP_MS = 20_000;
const REAP_MS = 5_000;
const MARKER = "pap-smoke-ok";
const PASSWORD = "correct horse battery staple";
const SCRIPT = {
  steps: [
    { toolCalls: [{ name: "bash", args: { command: `env echo ${MARKER}` }, id: "call-1" }] },
    { text: `The command printed ${MARKER}.` },
    // Only the lanes step reaches these: its lane worker walks the same script from the start (smoke-lanes.ts).
    { toolCalls: [{ name: "write", args: { path: "smoke-lane.txt", content: "lane\n" }, id: "call-2" }] },
    { text: "The lane file is written." },
  ],
};

async function drive(
  daemon: Daemon,
  port: number,
  work: string,
  userHome: string,
  agentDir: string,
): Promise<void> {
  const origin = `http://localhost:${port}`;
  const base = `http://127.0.0.1:${port}`;
  const listening = await within(daemon.line("listening"), STEP_MS, "the daemon to listen");
  step(`daemon listening on ${String(listening.url)}`);
  // node-pty must load from the built daemon: the boot probe logs terminal_unavailable when it does not (M8R51).
  if (daemon.output.some((line) => line.includes('"terminal_unavailable"')))
    throw new Error("node-pty did not load from the built daemon (terminal_unavailable in the boot log)");
  step("node-pty loads from the built daemon");
  const health = await http(`${base}/healthz`);
  if (health.status !== 200) throw new Error(`/healthz answered ${health.status}`);
  const page = await http(`${base}/`);
  if (page.status !== 200 || !String(page.headers["content-type"]).startsWith("text/html"))
    throw new Error(`/ gave ${page.status}: the web build is missing from the dist`);
  step("/healthz and the built web page answer");
  await checkPwa(base);

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
    const rules = JSON.stringify(await session.call("policy.listRules", { cwd: work }));
    if (rules !== '{"rules":[],"truncated":false}') throw new Error(`policy.listRules answered ${rules}`);
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
    if (asJson(toolEnd.event).isError !== false)
      throw new Error(`the tool failed: ${JSON.stringify(toolEnd)}`);
    const printed = (event: Json) => {
      const text = JSON.stringify(event);
      return isPi("message_end")(event) && text.includes('"role":"toolResult"') && text.includes(MARKER);
    };
    await session.waitFor(printed, `the tool result printing ${MARKER}`);
    await session.waitFor(isPi("agent_settled"), "agent_settled");
    step("prompt -> approval -> tool output -> agent_settled");
    const stepUp = async () => {
      const confirm = await http(`${base}/auth/confirm`, {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      });
      if (confirm.status !== 204) throw new Error(`/auth/confirm answered ${confirm.status}`);
    };
    await checkScannerAndSearch({ agentDir, cwd: work, socket: session });
    await checkModels({ agentDir, socket: session, stepUp });
    await checkLanes({
      port,
      origin,
      cookie,
      root: dirname(work),
      userHome,
      stepUp,
    });
    await checkTerminal({ cwd: work, socket: session });
  } finally {
    session.close();
  }

  const daemonPid = daemon.child.pid;
  if (daemonPid === undefined || daemonPid <= 1) throw new Error("the daemon has no process id of its own");
  const workers = descendantsOf(daemonPid);
  const hosts = workers.filter((pid) => cmdlineOf(pid).includes(PI_HOST));
  if (hosts.length === 0) throw new Error(`no worker running ${PI_HOST} was found under the daemon`);
  const flags = [`--import=${NETWORK_GUARD}`, "--max-semi-space-size=16"]; // the second one: WORKER_BUDGET_MB
  const bare = hosts.flatMap((pid) => flags.filter((f) => !cmdlineOf(pid).includes(f)));
  if (bare.length > 0) throw new Error(`a worker runs without ${bare.join(", ")}`);
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
      PAP_TEST_VMD_SOCKET: join(home, "no-vmd.sock"),
      PAP_TEST_WORKER_IMPORT: NETWORK_GUARD,
    };
    daemon = startDaemon(env, port);
    await drive(daemon, port, work, userHome, agent);
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
