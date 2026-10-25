import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  type MethodName,
  type ParamsOf,
  type ProjectView,
  type ResponseFrame,
  TriggerInput,
} from "@pap/contracts";
import { newRequestId } from "../modules/terminal/testing/wire.ts";
import { createTrigger } from "../security/testing/automation-bed.ts";
import { type BoxBed, startBoxBed } from "./box-bed.ts";
import { httpRequest } from "./http-client.ts";
import type { TestClient } from "./ws-client.ts";

/** The member's password: any 12 to 1024 characters. */
export const MEMBER_PASSWORD = "member horse battery staple";

/** Strings only the owner's rows hold: if one reaches the member, a row leaked. */
export const CANARY = {
  session: "CANARY-session-7f3a",
  project: "CANARY-project-7f3a",
  file: "CANARY-file-text-7f3a",
  trigger: "CANARY-trigger-7f3a",
  agent: "CANARY-agent-7f3a",
  inbox: "CANARY-inbox-7f3a",
} as const;

export interface Person {
  readonly id: string;
  readonly name: string;
  readonly cookie: string;
  readonly client: TestClient;
  /** A bearer token (sessions and files) for the HTTP and WebSocket bearer paths. */
  readonly token: string;
  /** Every RPC answer this person received, as JSON text: the canary check reads it. */
  readonly answers: string[];
  call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResponseFrame>;
  /** An HTTP request as this person's browser would send it. */
  http(
    path: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): ReturnType<typeof httpRequest>;
}

export interface OwnerSeeds {
  readonly project: ProjectView;
  readonly sessionId: string;
  readonly triggerId: string;
  readonly agentId: string;
  readonly inboxId: string;
  readonly filePath: string;
  readonly taskId: string;
  readonly terminalId: string;
  readonly tokenId: string;
  readonly deviceId: string;
}

export interface TwoUsers {
  readonly bed: BoxBed;
  readonly owner: Person;
  readonly member: Person;
  readonly seeds: OwnerSeeds;
  /** Everything the member was ever sent: RPC answers and every stream frame. */
  received(): string;
  stop(): Promise<void>;
}

const OUT = (frame: ResponseFrame): string => (frame.ok ? "ok" : frame.error.code);
export const codeOf = OUT;

/** Runs one statement on the daemon's database from outside (WAL: a second writer waits its turn). */
export function writeDb(home: string, sql: string, ...params: Array<string | number | null>): void {
  const db = new DatabaseSync(join(home, "state.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

function person(
  bed: BoxBed,
  base: { id: string; name: string; cookie: string; client: TestClient; token: string },
): Person {
  const answers: string[] = [];
  return {
    ...base,
    answers,
    async call(method, params) {
      const frame = await base.client.call(method, params);
      answers.push(JSON.stringify(frame));
      return frame;
    },
    http: (path, init = {}) =>
      httpRequest(`${bed.t.base}${path}`, {
        ...init,
        headers: { origin: bed.t.origin, cookie: base.cookie, ...init.headers },
      }),
  };
}

/** The owner as a `Person`: the bed's own cookie and socket, plus a token. */
export async function ownerOf(bed: BoxBed): Promise<Person> {
  const listed = await bed.owner.client.call("users.list", {});
  if (!listed.ok) throw new Error(`users.list: ${listed.error.code}`);
  const me = (listed.result as { users: Array<{ id: string; username: string; role: string }> }).users.find(
    (user) => user.role === "owner",
  );
  if (!me) throw new Error("no owner");
  return person(bed, {
    id: me.id,
    name: me.username,
    cookie: bed.owner.cookie,
    client: bed.owner.client,
    token: await tokenOf(bed.owner.client),
  });
}

async function tokenOf(client: TestClient): Promise<string> {
  const created = await client.call("auth.tokens.create", {
    name: "journey",
    permissions: ["sessions:read", "sessions:operate", "files:read"],
    expiresInDays: 7,
  });
  if (!created.ok) throw new Error(`token: ${created.error.code}`);
  return (created.result as { value: string }).value;
}

/** Invites `name` as the owner, accepts it over HTTP, signs in over a socket and mints a token. */
export async function addMember(bed: BoxBed, name = "mia"): Promise<Person> {
  await bed.t.confirmStepUp(bed.owner.cookie);
  const invited = await bed.owner.client.call("users.invite", { nameHint: name });
  if (!invited.ok) throw new Error(`users.invite: ${invited.error.code}`);
  const token = new URL((invited.result as { url: string }).url).hash.replace("#token=", "");
  const accepted = await httpRequest(`${bed.t.base}/auth/invite/accept`, {
    method: "POST",
    headers: { origin: bed.t.origin, "content-type": "application/json" },
    body: JSON.stringify({ token, username: name, password: MEMBER_PASSWORD }),
  });
  if (accepted.status !== 204) throw new Error(`accept ${accepted.status} ${accepted.body}`);
  const header = accepted.headers["set-cookie"];
  const cookie = ((Array.isArray(header) ? header[0] : header) ?? "").split(";")[0] ?? "";
  const confirmed = await httpRequest(`${bed.t.base}/auth/confirm`, {
    method: "POST",
    headers: { origin: bed.t.origin, cookie, "content-type": "application/json" },
    body: JSON.stringify({ password: MEMBER_PASSWORD }),
  });
  if (confirmed.status !== 204) throw new Error(`confirm ${confirmed.status}`);
  const client = await bed.t.connect(cookie);
  const listed = await bed.owner.client.call("users.list", {});
  const row = (
    listed.ok ? (listed.result as { users: Array<{ id: string; username: string }> }).users : []
  ).find((user) => user.username === name);
  if (!row) throw new Error("the member is not listed");
  return person(bed, { id: row.id, name, cookie, client, token: await tokenOf(client) });
}

/** Gives the owner one row of each kind, every one holding a canary. */
export async function seedOwner(bed: BoxBed, ownerId: string): Promise<OwnerSeeds> {
  const project = await bed.createProject(CANARY.project);
  await bed.startBox(project.id);
  const filePath = `${project.root}/canary.txt`;
  await bed.call("files.write", { path: filePath, text: CANARY.file, baseEtag: null });
  const sessionId = await bed.openSession(project.root);
  await bed.call("sessions.rename", { sessionId, name: CANARY.session });
  const created = await createTrigger(
    bed.owner.client,
    TriggerInput.parse({
      name: CANARY.trigger,
      source: { type: "manual" },
      execution: { cwd: project.root, tools: ["read"] },
      prompt: "Write the report.",
    }),
  );
  const agentId = await bed.createAgent({ name: CANARY.agent });
  const inboxId = "inbox-canary-0001";
  writeDb(
    bed.t.home,
    "INSERT INTO inbox_items (id, owner_id, kind, to_handle, title, created_at) VALUES (?, ?, 'canary', 0, ?, 1)",
    inboxId,
    ownerId,
    CANARY.inbox,
  );
  const fired = await bed.call<{ taskId?: string }>("automation.fire", { triggerId: created.id });
  const { terminalId } = await bed.call<{ terminalId: string }>("terminal.create", {
    requestId: newRequestId(),
    cwd: project.root,
    cols: 80,
    rows: 24,
  });
  const tokens = await bed.call<{ tokens: Array<{ id: string }> }>("auth.tokens.list", {});
  const devices = await bed.call<{ devices: Array<{ id: string }> }>("auth.devices.list", {});
  return {
    project,
    sessionId,
    triggerId: created.id,
    agentId,
    inboxId,
    filePath,
    taskId: fired.taskId ?? "task-missing",
    terminalId,
    tokenId: tokens.tokens[0]?.id ?? "token-missing",
    deviceId: devices.devices[0]?.id ?? "device-missing",
  };
}

/** A daemon on the process backend with an owner who owns canary rows, and a member who owns none. */
export async function startTwoUsers(
  script: object = { steps: Array.from({ length: 12 }, () => ({ text: "ok" })) },
  options: Parameters<typeof startBoxBed>[1] = {},
): Promise<TwoUsers> {
  const bed = await startBoxBed(script, options);
  try {
    const owner = await ownerOf(bed);
    const member = await addMember(bed);
    const seeds = await seedOwner(bed, owner.id);
    return {
      bed,
      owner,
      member,
      seeds,
      received: () =>
        JSON.stringify([member.answers, member.client.events, member.client.binaryFrames.length]),
      async stop() {
        member.client.close();
        await bed.stop();
      },
    };
  } catch (error) {
    await bed.stop();
    throw error;
  }
}
