import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditView, EventFrame, ResponseFrame } from "@pap/contracts";
import { expect, vi } from "vitest";
import type { HttpReply } from "../../testing/http-client.ts";
import { startTestDaemon, type TestDaemon, type TestDaemonOptions } from "../../testing/harness.ts";
import type { TestClient } from "../../testing/ws-client.ts";

// Shared by the security suite (spec C §8.1). MCP is not here: the production worker loads no MCP (M5 Task 9 ruling),
// so MCP exit criteria run in-process in packages/pi-host (host.taint.mcp*.int.test.ts).

type StreamEvent = { kind?: string; status?: string; dialog?: { id?: string } };
const streamOf = (frame: EventFrame) => frame.event as StreamEvent;

export const isDialog = (frame: EventFrame): boolean => streamOf(frame).kind === "dialog_open";

export function dialogIdOf(frame: EventFrame): string {
  const id = streamOf(frame).dialog?.id;
  if (typeof id !== "string") throw new Error("not a dialog frame");
  return id;
}

export function sessionIdOf(frame: ResponseFrame): string {
  if (!frame.ok) throw new Error(`call failed: ${JSON.stringify(frame)}`);
  return (frame.result as { sessionId: string }).sessionId;
}

export function rowsOf(frame: ResponseFrame): AuditView[] {
  if (!frame.ok) throw new Error(`call failed: ${JSON.stringify(frame)}`);
  return (frame.result as { entries: AuditView[] }).entries;
}

/**
 * The newest stream position the client has seen: a mark taken before a prompt, for `waitIdle` and the waits below.
 * Seq spaces are per channel, so this assumes one subscription per client (the suite subscribes to one session).
 */
export const markOf = (client: TestClient): number => client.events.at(-1)?.seq ?? -1;

/** Waits for the run that started after `after` to end: a `running` status, then the `idle` that follows it. */
export async function waitIdle(client: TestClient, after: number): Promise<void> {
  const running = await client.waitForEvent((f) => streamOf(f).status === "running" && f.seq > after);
  await client.waitForEvent((f) => streamOf(f).status === "idle" && f.seq > running.seq);
}

/** An idle that ends a run: the status before it was `running` (a worker starting up also reports `idle`). */
function endsARun(events: readonly EventFrame[], frame: EventFrame): boolean {
  if (streamOf(frame).status !== "idle") return false;
  const previous = events
    .slice(0, events.indexOf(frame))
    .reverse()
    .find((f) => streamOf(f).status !== undefined);
  return previous !== undefined && streamOf(previous).status === "running";
}

/**
 * The first card, or the end of the run, after `after`. A test that expects (or forbids) a card waits for this
 * instead of for a card alone: the wrong outcome fails at once with its own assertion, not after the wait for the
 * outcome that never comes.
 */
export async function firstDialogOrIdle(
  client: TestClient,
  after: number,
): Promise<{ kind: "dialog" | "idle"; frame: EventFrame }> {
  const frame = await client.waitForEvent(
    (f) => f.seq > after && (isDialog(f) || endsARun(client.events, f)),
  );
  return { kind: isDialog(frame) ? "dialog" : "idle", frame };
}

/** The card the policy raises after `after`; fails at once, naming the idle status, when the run ended without one. */
export async function nextDialog(client: TestClient, after: number): Promise<EventFrame> {
  const first = await firstDialogOrIdle(client, after);
  expect(first.kind, "the run ended without a card").toBe("dialog");
  return first.frame;
}

/** Waits for the run to end after `after` and fails at once when a card came first. */
export async function runWithoutCard(client: TestClient, after: number): Promise<void> {
  const first = await firstDialogOrIdle(client, after);
  expect(first.kind, "a card asked before the run ended").toBe("idle");
}

/** One request with the path sent exactly as written: nothing normalises it on the way (unlike `fetch` and `URL`). */
export function rawSend(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body: string | Buffer | null = null,
  timeoutMs = 10_000,
): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const sent = body === null ? headers : { ...headers, "content-length": String(Buffer.byteLength(body)) };
    const req = request(
      { host: "127.0.0.1", port, path, method, headers: sent, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error(`no reply to ${method} ${path} within ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end(body);
  });
}

export const rawGet = (
  port: number,
  path: string,
  headers: Record<string, string> = {},
  timeoutMs = 10_000,
): Promise<HttpReply> => rawSend(port, "GET", path, headers, null, timeoutMs);

export const rawPut = (port: number, path: string, headers: Record<string, string>, body: string | Buffer) =>
  rawSend(port, "PUT", path, headers, body);

export const rawPost = (port: number, path: string, headers: Record<string, string>, body: string | Buffer) =>
  rawSend(port, "POST", path, headers, body);

/** Pi extensions: tools that return a fixed text and never open a socket. */
export const FETCH_PAGE_TOOL = `export default function (pi) {
  pi.registerTool({
    name: "fetch_page",
    label: "fetch_page",
    description: "returns a fixed page",
    parameters: { type: "object", properties: { url: { type: "string" } }, additionalProperties: true },
    execute: async () => ({ content: [{ type: "text", text: "a fixed page" }], details: {} }),
  });
}
`;

/** An extension tool `lookup` (external by default, M5R39) that returns `reply`. */
export const lookupTool = (reply: string): string => `export default function (pi) {
  pi.registerTool({
    name: "lookup",
    label: "lookup",
    description: "looks something up",
    parameters: { type: "object", properties: { q: { type: "string" } }, additionalProperties: true },
    execute: async () => ({ content: [{ type: "text", text: ${JSON.stringify(reply)} }], details: {} }),
  });
}
`;

/** Call rows of a session; polled because the worker's audit records reach the daemon a moment after the stream. */
export async function callRows(client: TestClient, sessionId: string, count: number): Promise<AuditView[]> {
  let rows: AuditView[] = [];
  await vi.waitFor(
    async () => {
      const all = rowsOf(await client.call("audit.list", { sessionId, limit: 200 }));
      rows = all.filter((row) => row.kind === "call");
      expect(rows).toHaveLength(count);
    },
    { timeout: 20_000, interval: 50 },
  );
  return rows;
}

/** SIGKILL of the worker's process group; a pid of 0 or 1 would signal far more than that. */
export function killWorkerOf(t: TestDaemon, sessionId: string): number {
  const pid = t.daemon.inspect.workerPid(sessionId);
  expect(pid).toBeGreaterThan(1);
  process.kill(-(pid ?? 0), "SIGKILL");
  return pid ?? 0;
}

/** Stage id -> every outcome that stage gave across the rows (calls and results). */
export function stagesSeen(rows: readonly AuditView[]): Record<string, string[]> {
  const seen: Record<string, string[]> = {};
  for (const verdict of rows.flatMap((row) => row.stages)) (seen[verdict.stage] ??= []).push(verdict.outcome);
  return seen;
}

// ---- The file bed: one daemon whose owner holds three roots (spec C §8.1, M8R67) ----

export const SECRET_TEXT = "SECRET_TEXT_outside_the_roots";
export const AUTH_KEY = "sk-test-AUTH_KEY_private_to_pi";
export const NOT_FOUND_BODY = JSON.stringify({ error: { code: "not_found" } });
const PI_FILES = {
  "auth.json": JSON.stringify({ key: AUTH_KEY }),
  "models.json": '{"models":[]}',
  "mcp.json": '{"mcpServers":{}}',
  "settings.json": "{}",
  "trust.json": "{}",
  "sessions/x.jsonl": "{}\n",
} as const;

export interface FileBed {
  readonly t: TestDaemon;
  readonly cookie: string;
  readonly client: TestClient;
  /** The session's folder: a git repository and a project root. */
  readonly R: string;
  /** A folder outside every root, holding `secret.txt` (and `deep/`). */
  readonly O: string;
  /** Another folder no project holds. */
  readonly free: string;
  /** The harness's home folder, a project root itself (owner f8). */
  readonly userHome: string;
  /** `t.root`, a project root that holds pap's home and Pi's folder. */
  readonly holder: string;
  readonly agentDir: string;
  /** A request header set for a mutating browser call. */
  readonly browser: Record<string, string>;
  stop(): Promise<void>;
}

const GIT_ENV = (home: string) => ({
  PATH: process.env.PATH,
  HOME: home,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
});

/**
 * Builds R (a repository with `ok.txt`, `.pi/mcp.json` and `.mcp.json` committed), the hostile links, the hard links to
 * pap's and Pi's private files, and three roots: R, `t.root` and the home folder. Nothing here runs a destructive command.
 */
export async function startFileBed(options: TestDaemonOptions = {}): Promise<FileBed> {
  const outer = mkdtempSync(join(tmpdir(), "pap-sec-"));
  const O = join(outer, "outside");
  const free = join(outer, "free");
  for (const dir of [join(O, "deep"), free]) mkdirSync(dir, { recursive: true });
  for (const dir of [O, free, join(O, "deep")]) writeFileSync(join(dir, "secret.txt"), SECRET_TEXT);
  let t: TestDaemon | undefined;
  try {
    t = await startTestDaemon(
      { steps: [{ text: "hi" }] },
      {
        ...options,
        agentFiles: { ...PI_FILES, ...options.agentFiles },
        workerEnv: { SHELL: "/bin/sh", ...options.workerEnv },
      },
    );
    const R = t.cwd;
    const agentDir = join(t.root, "agent");
    const userHome = join(t.root, "user");
    const gitHome = join(outer, "git-home");
    mkdirSync(gitHome);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: R, stdio: "ignore", env: GIT_ENV(gitHome) });
    git("init", "-q", "-b", "main");
    mkdirSync(join(R, ".pi"));
    writeFileSync(join(R, "ok.txt"), "ok\n");
    writeFileSync(join(R, ".pi/mcp.json"), '{"mcpServers":{}}');
    writeFileSync(join(R, ".mcp.json"), '{"mcpServers":{}}');
    git("add", ".");
    git("commit", "-q", "-m", "init");
    writeFileSync(join(R, "ok.txt"), "ok, changed\n");
    writeFileSync(join(R, "x.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(R, "x.html"), "<script>1</script>");
    symlinkSync(O, join(R, "link-out"));
    symlinkSync(join(O, "deep"), join(R, "lnk"));
    // The other way round: spelled outside every root, resolving inside one.
    symlinkSync(join(R, "ok.txt"), join(O, "into-r"));
    symlinkSync(R, join(O, "into-dir"));
    symlinkSync("/proc/self/cwd", join(R, "x"));
    symlinkSync("/proc/self/root", join(R, "r"));
    execFileSync("mkfifo", [join(R, "fifo")]);
    // RT-01: the same inodes as Pi's key file and pap's database, under ordinary names.
    linkSync(join(agentDir, "auth.json"), join(R, "notes.txt"));
    linkSync(join(t.home, "state.db"), join(R, "db.bin"));
    for (const dir of [".ssh", "proj"]) mkdirSync(join(userHome, dir));
    writeFileSync(join(userHome, ".bashrc"), "# rc\n");
    writeFileSync(join(userHome, ".ssh/id"), "SECRET_TEXT_ssh_key");
    writeFileSync(join(userHome, "proj/a.txt"), "a\n");
    const cookie = await t.login();
    const client = await t.connect(cookie);
    for (const cwd of [R, t.root, userHome]) {
      const created = await client.call("sessions.create", { cwd });
      if (!created.ok) throw new Error(`sessions.create ${cwd}: ${created.error.code}`);
    }
    const bed = t;
    return {
      t,
      cookie,
      client,
      R,
      O,
      free,
      userHome,
      holder: t.root,
      agentDir,
      browser: { cookie, origin: t.origin },
      async stop() {
        client.close();
        try {
          await bed.stop();
        } finally {
          rmSync(outer, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await t?.stop();
    rmSync(outer, { recursive: true, force: true });
    throw error;
  }
}

/** A token with `permissions`, minted by the owner after a step-up; returns its value. */
export async function mintToken(bed: FileBed, permissions: string[]): Promise<string> {
  await bed.t.confirmStepUp(bed.cookie);
  const created = await bed.client.call("auth.tokens.create", {
    name: "ci",
    permissions: permissions as never,
    expiresInDays: 7,
  });
  if (!created.ok) throw new Error(`token create failed: ${created.error.code}`);
  return (created.result as { value: string }).value;
}

/** The error code of a failed call, or `ok` when it succeeded: one value to compare in a table. */
export const outcomeOf = (frame: ResponseFrame): string => (frame.ok ? "ok" : frame.error.code);
