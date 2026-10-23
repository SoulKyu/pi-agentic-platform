import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { MethodName, ParamsOf, ResponseFrame } from "@pap/contracts";
import type { TestDaemon, TestDaemonOptions } from "../../testing/harness.ts";
import { httpRequest } from "../../testing/http-client.ts";
import type { TestClient } from "../../testing/ws-client.ts";
import { result, rows } from "./automation-bed.ts";

// Shared by the M11 exit-proof suites (Task 20): a real daemon, real workers on the scripted provider and the host's real
// bwrap. Nothing here reaches the network, ~/.pap or ~/.pi/agent.

/** A call that must have succeeded, typed. */
export const callOf =
  (client: TestClient) =>
  async <T>(method: MethodName, params: object): Promise<T> =>
    result<T>(await client.call(method, params as ParamsOf<typeof method>));

/** The answer of a call whatever it is: `ok`, or the error code. */
export const codeOf = (frame: ResponseFrame): string => (frame.ok ? "ok" : frame.error.code);

/** The script the next worker to start reads (a worker reads it once, at its start). */
export const writeScript = (t: TestDaemon, script: object): void =>
  writeFileSync(join(t.root, "script.json"), JSON.stringify(script));

export const bash = (command: string, id: string) => ({
  toolCalls: [{ name: "bash", args: { command }, id }],
});

export interface AuditRow {
  readonly tool: string | null;
  readonly decision: string;
  readonly reason: string | null;
  readonly detail: Record<string, unknown> | null;
}

/** The worker-side policy rows of one session, oldest first, `detail` parsed. */
export const policyRows = (t: TestDaemon, sessionId: string): AuditRow[] =>
  rows<{ tool: string | null; decision: string; reason: string | null; detail: string | null }>(
    t.home,
    "SELECT tool, decision, reason, detail FROM audit WHERE session_id = ? AND kind = 'policy' AND actor = 'worker' ORDER BY id",
    sessionId,
  ).map((row) => ({
    ...row,
    detail: row.detail === null ? null : (JSON.parse(row.detail) as AuditRow["detail"]),
  }));

/** The platform op rows of a session: the tool is `<domain>.<verb>`, which no Pi tool name is. */
export const opRows = (t: TestDaemon, sessionId: string): AuditRow[] =>
  policyRows(t, sessionId).filter((row) => /^[a-z]+\.[a-z]+$/.test(row.tool ?? ""));

export interface PendingRequest {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly state: string;
  readonly session_id: string;
}
export const requestRows = (t: TestDaemon): PendingRequest[] =>
  rows<PendingRequest>(
    t.home,
    "SELECT id, kind, title, state, session_id FROM agent_requests ORDER BY created_at, id",
  );

export interface TaskRow {
  readonly id: string;
  readonly state: string;
  readonly reason: string | null;
  readonly origin: string;
  readonly target: string;
  readonly tainted: number;
  readonly agent_id: string | null;
  readonly requested_by: string | null;
  readonly prompt: string;
  readonly session_id: string | null;
}
export const taskRowsOf = (t: TestDaemon, agentId?: string): TaskRow[] =>
  rows<TaskRow>(
    t.home,
    `SELECT id, state, reason, origin, target, tainted, agent_id, requested_by, prompt, session_id FROM tasks
     ${agentId === undefined ? "" : "WHERE agent_id = ?"} ORDER BY created_at, id`,
    ...(agentId === undefined ? [] : [agentId]),
  );

/** Everything a platform op can change, counted: a refused call leaves every figure where it was. */
export interface Effects {
  readonly agentItems: number;
  readonly requests: number;
  readonly agentTasks: number;
  readonly laneNotes: number;
  readonly cards: number;
}
export function effectsOf(t: TestDaemon): Effects {
  const count = (sql: string): number => rows<{ n: number }>(t.home, sql)[0]?.n ?? -1;
  return {
    agentItems: count(
      "SELECT count(*) AS n FROM inbox_items WHERE kind IN ('agent_notify', 'agent_approve', 'secret_request')",
    ),
    requests: count("SELECT count(*) AS n FROM agent_requests"),
    agentTasks: count("SELECT count(*) AS n FROM tasks WHERE origin IN ('delegate', 'remind')"),
    laneNotes: count("SELECT count(*) AS n FROM lanes WHERE note IS NOT NULL"),
    cards: count("SELECT count(*) AS n FROM agent_events"),
  };
}

const OWNER_PASSWORD = "correct horse battery staple";

/** The owner signed in again on a daemon that restarted on the same folders: a login (there is no setup URL now) and the step-up. */
export async function reopenOwner(t: TestDaemon): Promise<{ cookie: string; client: TestClient }> {
  const reply = await httpRequest(`${t.base}/auth/login`, {
    method: "POST",
    headers: { origin: t.origin, "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: OWNER_PASSWORD }),
  });
  const header = reply.headers["set-cookie"];
  const cookie = ((Array.isArray(header) ? header[0] : header) ?? "").split(";")[0] ?? "";
  if (cookie === "") throw new Error(`login failed: ${reply.status} ${reply.body}`);
  await t.confirmStepUp(cookie);
  return { cookie, client: await t.connect(cookie) };
}

const GUARD = fileURLToPath(
  new URL("../../../../../packages/pi-host/src/testing/network-guard.ts", import.meta.url),
);
const COUNTER = fileURLToPath(new URL("./spawn-counter.ts", import.meta.url));

/** The daemon options that make every worker log its start to `file`: the supervisor's spawn count, seen from outside. */
export const spawnCounting = (file: string): Pick<TestDaemonOptions, "config" | "workerEnv"> => ({
  config: {
    piHostExecArgv: [
      "--conditions=development",
      "--disable-warning=ExperimentalWarning",
      "--import",
      GUARD,
      "--import",
      COUNTER,
    ],
  },
  workerEnv: { TEST_SPAWN_LOG: file },
});

/** How many workers started so far. */
export const spawnsOf = (file: string): number =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
