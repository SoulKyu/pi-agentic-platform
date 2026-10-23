import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@pap/contracts";
import { vi } from "vitest";
import { freePort } from "../../testing/free-port.ts";
import { httpRequest } from "../../testing/http-client.ts";
import { connectTestClient, type TestClient } from "../../testing/ws-client.ts";

// A real `main.ts` in a child process, on a home that outlives it (M10R79). The test kills it with SIGKILL where it
// stands, starts the next life on the same home and reads what recovery did. Nothing here reaches ~/.pap or ~/.pi/agent,
// the network is blocked in every worker, and only pids this file started (or found under them) are ever signalled.

const MAIN = fileURLToPath(new URL("../../main.ts", import.meta.url));
const GUARD = fileURLToPath(
  new URL("../../../../../packages/pi-host/src/testing/network-guard.ts", import.meta.url),
);
export const OWNER_PASSWORD = "correct horse battery staple";

export interface Life {
  readonly pid: number;
  readonly port: number;
  readonly origin: string;
  readonly lines: Array<Record<string, unknown>>;
  stderr(): string;
  /** The direct children of the daemon: its workers (a worker is spawned by the daemon, not by a shell). */
  workers(): number[];
  /** SIGKILL where it stands; resolves once the process is gone. */
  kill(): Promise<void>;
  /** SIGTERM, the daemon's own clean stop; resolves with its exit code. */
  stop(): Promise<number | null>;
  connect(cookie: string): Promise<TestClient>;
}

export interface CrashBed {
  readonly root: string;
  readonly home: string;
  readonly cwd: string;
  readonly agentDir: string;
  /** The scripted provider's script: read by each worker when it starts, so a test can change it between lives. */
  script(steps: object): void;
  start(hold?: string): Promise<Life>;
  /** The cookie of the owner, set by `signUp` in the first life and kept for the next ones. */
  cookie: string;
  signUp(life: Life): Promise<string>;
  dispose(): Promise<void>;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** `ps` exits 1 when the process has no child, which is an answer here, not a failure. */
function childrenOf(pid: number): number[] {
  let text = "";
  try {
    text = execFileSync("ps", ["-o", "pid=", "--ppid", String(pid)], { encoding: "utf8" });
  } catch (error) {
    if ((error as { status?: number }).status !== 1) throw error;
  }
  return text
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((child) => Number.isInteger(child) && child > 1);
}

export function createCrashBed(steps: object): CrashBed {
  const root = mkdtempSync(join(tmpdir(), "pap-crash-"));
  const home = join(root, "home");
  const cwd = join(root, "work");
  const agentDir = join(root, "agent");
  for (const dir of [cwd, agentDir, join(root, "user")]) mkdirSync(dir);
  const scriptPath = join(root, "script.json");
  writeFileSync(scriptPath, JSON.stringify(steps));
  const daemons: ChildProcess[] = [];
  const seenWorkers = new Set<number>();

  const bed: CrashBed = {
    root,
    home,
    cwd,
    agentDir,
    cookie: "",
    script: (next) => writeFileSync(scriptPath, JSON.stringify(next)),
    async start(hold) {
      const port = await freePort();
      const child = spawn(
        process.execPath,
        [
          "--disable-warning=ExperimentalWarning",
          "--conditions=development",
          MAIN,
          "serve",
          "--port",
          String(port),
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: process.env.PATH,
            LANG: process.env.LANG,
            HOME: join(root, "user"),
            PAP_HOME: home,
            PI_CODING_AGENT_DIR: agentDir,
            PI_TELEMETRY: "0",
            PI_OFFLINE: "1",
            PAP_WORKER_SCOPE: "off",
            PAP_MIN_FREE_MEM_MB: "0",
            PAP_MIN_FREE_DISK_MB: "0",
            PAP_UPDATE_CHECK: "0",
            PAP_TEST_PROVIDER_SCRIPT: scriptPath,
            PAP_TEST_VMD_SOCKET: join(root, "no-vmd.sock"),
            PAP_TEST_WORKER_IMPORT: GUARD,
            ...(hold === undefined ? {} : { PAP_TEST_OUTBOX_HOLD: hold }),
          },
        },
      );
      daemons.push(child);
      const lines: Array<Record<string, unknown>> = [];
      let err = "";
      let pending = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        pending += chunk.toString("utf8");
        for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
          lines.push(JSON.parse(pending.slice(0, at)) as Record<string, unknown>);
          pending = pending.slice(at + 1);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
      const closed = new Promise<{ code: number | null }>((resolve) =>
        child.once("close", (code) => resolve({ code })),
      );
      await vi.waitFor(
        () => {
          if (err !== "") throw new Error(`the daemon refused to start: ${err}`);
          if (!lines.some((line) => line.msg === "listening")) throw new Error("not listening yet");
        },
        { timeout: 30_000, interval: 50 },
      );
      const pid = child.pid as number;
      const origin = `http://localhost:${port}`;
      return {
        pid,
        port,
        origin,
        lines,
        stderr: () => err,
        workers() {
          const found = childrenOf(pid);
          for (const worker of found) seenWorkers.add(worker);
          return found;
        },
        async kill() {
          for (const worker of childrenOf(pid)) seenWorkers.add(worker);
          child.kill("SIGKILL");
          await closed;
        },
        async stop() {
          child.kill("SIGTERM");
          return (await closed).code;
        },
        connect: (cookie) =>
          connectTestClient(`ws://127.0.0.1:${port}/ws?proto=${PROTOCOL_VERSION}`, { origin, cookie }),
      };
    },
    async signUp(life) {
      // `listening` is logged inside the daemon's start and `setup_url` right after it, by main.ts: two writes that
      // can reach this process in two chunks, so a start that has seen `listening` may not have the setup line yet.
      const noSetup = () =>
        new Error(`the daemon printed no setup_url (stderr: ${life.stderr() || "empty"})`);
      await vi.waitFor(
        () => {
          if (!life.lines.some((line) => line.msg === "setup_url")) throw noSetup();
        },
        { timeout: 30_000, interval: 50 },
      );
      const setup = life.lines.find((line) => line.msg === "setup_url");
      if (typeof setup?.url !== "string") throw noSetup();
      const token = new URL(setup.url).hash.replace("#token=", "");
      const reply = await httpRequest(`http://127.0.0.1:${life.port}/auth/setup`, {
        method: "POST",
        headers: { origin: life.origin, "content-type": "application/json" },
        body: JSON.stringify({ token, username: "owner", password: OWNER_PASSWORD }),
      });
      if (reply.status !== 201) throw new Error(`setup failed: ${reply.status} ${reply.body}`);
      const header = reply.headers["set-cookie"];
      bed.cookie = ((Array.isArray(header) ? header[0] : header) ?? "").split(";")[0] ?? "";
      const confirm = await httpRequest(`http://127.0.0.1:${life.port}/auth/confirm`, {
        method: "POST",
        headers: { origin: life.origin, cookie: bed.cookie, "content-type": "application/json" },
        body: JSON.stringify({ password: OWNER_PASSWORD }),
      });
      if (confirm.status !== 204) throw new Error(`confirm failed: ${confirm.status}`);
      return bed.cookie;
    },
    async dispose() {
      for (const child of daemons)
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      // A worker the killed daemon left: waited for, and only a pid found under one of our daemons is ever signalled.
      for (const pid of seenWorkers) {
        try {
          if (alive(pid) && readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("pi-host"))
            process.kill(pid, "SIGKILL");
        } catch {
          // Gone between the check and the signal.
        }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
  return bed;
}

/** Waits for the workers of a killed daemon to leave on their own (the parent watchdog); fails, naming them, if they stay. */
export async function workersGone(pids: readonly number[]): Promise<void> {
  await vi.waitFor(
    () => {
      const staying = pids.filter(alive);
      if (staying.length > 0) throw new Error(`workers still alive: ${staying.join(", ")}`);
    },
    { timeout: 45_000, interval: 100 },
  );
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part as { text?: string }).text ?? "").join("")
      : "";

/** The user messages of every Pi session file of the bed, in file order, as their text. */
export function userMessages(bed: CrashBed): string[] {
  const files = readdirSync(bed.agentDir, { recursive: true, encoding: "utf8" }).filter((name) =>
    name.endsWith(".jsonl"),
  );
  return files.flatMap((name) =>
    readFileSync(join(bed.agentDir, name), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } })
      .filter((entry) => entry.type === "message" && entry.message?.role === "user")
      .map((entry) => textOf(entry.message?.content)),
  );
}
