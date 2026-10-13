// Helpers of the post-build smoke test (smoke-dist.ts) and its steps (smoke-search.ts): a bounded wait, a free port,
// node:http, the daemon child process and the authenticated websocket.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

export const REPO = fileURLToPath(new URL("..", import.meta.url));
export const DAEMON = join(REPO, "apps/daemon/dist/main.js");
// Plain TypeScript with node:net only: Node strips the types, so it needs no build.
export const NETWORK_GUARD = join(REPO, "packages/pi-host/src/testing/network-guard.ts");
export const PROTOCOL = 2;
export const STEP_MS = 60_000;

export type Json = Record<string, unknown>;
export const step = (message: string): void => console.log(`smoke: ${message}`);
export const asJson = (value: unknown): Json =>
  typeof value === "object" && value !== null ? (value as Json) : {};

export function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
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

export function freePort(): Promise<number> {
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
export function http(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
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

export interface Daemon {
  readonly child: ChildProcess;
  readonly output: string[];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  line(msg: string): Promise<Json>;
}

export function startDaemon(env: NodeJS.ProcessEnv, port: number): Daemon {
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

export interface SmokeSocket {
  call(method: string, params: Json, mutation?: boolean): Promise<unknown>;
  waitFor(match: (event: Json) => boolean, what: string): Promise<Json>;
  close(): void;
}

export async function openSession(port: number, origin: string, cookie: string): Promise<SmokeSocket> {
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

export const isPi =
  (type: string) =>
  (event: Json): boolean =>
    event.kind === "pi" && asJson(event.event).type === type;
