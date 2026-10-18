// One built pap daemon for one spec file and project (M13R3): temporary HOME, PAP_HOME and PI_CODING_AGENT_DIR, the
// scripted provider, the network guard, no systemd scope. The environment is the smoke test's (scripts/smoke-dist.ts):
// nothing of the outer PI_*, PAP_* or credentials reaches the daemon or its workers.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON, type Daemon, freePort, NETWORK_GUARD, STEP_MS, startDaemon, within } from "../smoke-lib.ts";
import { descendantsOf, running, runningUnder } from "../smoke-proc.ts";

// J13 only: the guard lets the daemon reach the loopback push sink (see loopback-guard.ts).
const LOOPBACK_GUARD = fileURLToPath(new URL("./loopback-guard.ts", import.meta.url));
const STOP_MS = 20_000;
const REAP_MS = 5_000;

export interface ScriptStep {
  text?: string;
  toolCalls?: { name: string; args: Record<string, unknown>; id: string }[];
}

export interface PapProcess {
  /** `http://localhost:<port>`: localhost, never 127.0.0.1, because the WebAuthn rpID and the allowed origins need it. */
  readonly origin: string;
  readonly port: number;
  readonly home: string;
  readonly agentDir: string;
  readonly userHome: string;
  readonly work: string;
  readonly owner: { readonly username: string; readonly password: string };
  readonly setupUrl: string;
  lines(): Record<string, unknown>[];
  piFile(sessionId: string): string;
  restart(): Promise<void>;
  stop(): Promise<number>;
}

const git = (cwd: string, userHome: string, ...args: string[]): void => {
  execFileSync("git", args, {
    cwd,
    env: { PATH: process.env["PATH"], HOME: userHome, GIT_CONFIG_NOSYSTEM: "1" },
  });
};

function firstLine(path: string): string {
  const text = readFileSync(path, "utf8");
  const end = text.indexOf("\n");
  return end < 0 ? text : text.slice(0, end);
}

/** pap's session id is not the id in the Pi file's header: the daemon's own table maps one to the other. */
function recordedPiPath(home: string, sessionId: string): string | null {
  const db = new DatabaseSync(join(home, "state.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT pi_path FROM sessions WHERE id = ?").get(sessionId) as
      { pi_path: string | null } | undefined;
    return row?.pi_path ?? null;
  } finally {
    db.close();
  }
}

function findPiFile(home: string, agentDir: string, sessionId: string): string {
  const recorded = recordedPiPath(home, sessionId);
  if (recorded !== null) return recorded;
  const root = join(agentDir, "sessions");
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const path = join(entry.parentPath, entry.name);
    try {
      if ((JSON.parse(firstLine(path)) as { id?: unknown }).id === sessionId) return path;
    } catch {
      // a file that is not a session header
    }
  }
  throw new Error(`no Pi session file with id ${sessionId} under ${root}`);
}

export async function startPap(
  script: readonly ScriptStep[],
  extraEnv: Record<string, string>,
): Promise<{ pap: PapProcess; cleanup(): Promise<void> }> {
  const root = mkdtempSync(join(tmpdir(), "pap-e2e-"));
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const userHome = join(root, "user");
  const work = join(root, "work");
  for (const dir of [agentDir, userHome, work]) mkdirSync(dir);
  // Lane commits fail without an identity; the fake key only lets the model list show a signed-in provider (M13R32).
  writeFileSync(join(userHome, ".gitconfig"), "[user]\n\tname = E2E\n\temail = e2e@example.com\n");
  writeFileSync(join(agentDir, "auth.json"), '{"anthropic":{"type":"api_key","key":"e2e-fake-not-a-key"}}\n');
  chmodSync(join(agentDir, "auth.json"), 0o600);
  git(work, userHome, "init", "-q", "-b", "main");
  writeFileSync(join(work, "README.md"), "e2e\n");
  git(work, userHome, "add", ".");
  git(work, userHome, "commit", "-q", "-m", "init");
  const scriptFile = join(root, "script.json");
  writeFileSync(scriptFile, JSON.stringify({ steps: script }));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"],
    LANG: process.env["LANG"] ?? "C.UTF-8",
    HOME: userHome,
    PAP_HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    PAP_WORKER_SCOPE: "off",
    PAP_MIN_FREE_DISK_MB: "0",
    PAP_TEST_PROVIDER_SCRIPT: scriptFile,
    PAP_TEST_WORKER_IMPORT: NETWORK_GUARD,
    ...extraEnv,
  };
  const origin = `http://localhost:${port}`;
  const journal: string[][] = [];
  let daemon: Daemon | null = null;

  const boot = async (): Promise<Daemon> => {
    // PAP_TEST_PUSH_LOOPBACK means a push sink on 127.0.0.1: the daemon's own guard must let that connect through.
    const launch =
      env["PAP_TEST_PUSH_LOOPBACK"] === "1"
        ? {
            file: process.execPath,
            args: [
              "--disable-warning=ExperimentalWarning",
              `--import=${LOOPBACK_GUARD}`,
              DAEMON,
              "serve",
              "--port",
              String(port),
            ],
          }
        : undefined;
    const started = startDaemon(env, port, launch);
    journal.push(started.output);
    daemon = started;
    await within(started.line("listening"), STEP_MS, "the daemon to listen");
    return started;
  };
  const kill = (pids: number[]): void => {
    for (const pid of pids) {
      if (pid <= 1 || pid === process.pid) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  };
  const halt = async (): Promise<number> => {
    const current = daemon;
    if (!current) return 0;
    daemon = null;
    const pid = current.child.pid ?? 0;
    const workers = descendantsOf(pid);
    current.child.kill("SIGTERM");
    const exit = await within(current.exited, STOP_MS, "the daemon to stop on SIGTERM");
    const deadline = Date.now() + REAP_MS;
    while (workers.some(running) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const left = [...new Set([...workers.filter(running), ...runningUnder(userHome)])];
    kill(left);
    if (left.length > 0) throw new Error(`processes left after the stop: ${left.join(", ")}`);
    return exit.code ?? 1;
  };

  const cleanup = async (): Promise<void> => {
    try {
      await halt();
    } finally {
      kill(runningUnder(userHome));
      rmSync(root, { recursive: true, force: true });
    }
  };
  let token: string;
  try {
    const setup = await within((await boot()).line("setup_url"), STEP_MS, "the setup address");
    token = new URL(String(setup["url"])).hash.replace("#token=", "");
  } catch (error) {
    await cleanup().catch((cleanupError: unknown) =>
      console.error(`e2e: cleanup after a failed boot also failed: ${String(cleanupError)}`),
    );
    throw error;
  }
  const owner = { username: "owner", password: `e2e-${randomBytes(9).toString("hex")}` };

  const pap: PapProcess = {
    origin,
    port,
    home,
    agentDir,
    userHome,
    work: realpathSync(work),
    owner,
    setupUrl: `${origin}/#token=${token}`,
    lines: () =>
      journal
        .flat()
        .filter((line) => line.startsWith("{"))
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>];
          } catch {
            return [];
          }
        }),
    piFile: (sessionId) => findPiFile(home, agentDir, sessionId),
    async restart() {
      const code = await halt();
      if (code !== 0) throw new Error(`the daemon exited with ${code} on SIGTERM, expected 0`);
      await boot();
    },
    stop: halt,
  };
  return { pap, cleanup };
}
