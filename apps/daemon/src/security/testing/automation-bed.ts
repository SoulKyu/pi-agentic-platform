import { createHmac } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AutomationSettings, type ResponseFrame, TriggerInput } from "@pap/contracts";
import { expect } from "vitest";
import type { TestDaemon } from "../../testing/harness.ts";
import { httpRequest } from "../../testing/http-client.ts";
import type { TestClient } from "../../testing/ws-client.ts";

// Shared by the automation exit proofs (M10 Task 11): the owner's browser connection, triggers, deliveries and a
// read-only look at the daemon's database. Nothing here reaches past the test daemon's own temporary home.

export interface Owner {
  readonly cookie: string;
  readonly client: TestClient;
}

/** The harness owner, signed in and past the password step-up, with one WebSocket. */
export async function openOwner(t: TestDaemon): Promise<Owner> {
  const cookie = await t.login();
  await t.confirmStepUp(cookie);
  return { cookie, client: await t.connect(cookie) };
}

export const result = <T>(frame: ResponseFrame): T => {
  if (!frame.ok) throw new Error(`call failed: ${frame.error.code}`);
  return frame.result as T;
};

export const outcome = (frame: ResponseFrame): string => (frame.ok ? "ok" : frame.error.code);

export interface Created {
  readonly id: string;
  readonly secret: string;
}

/** A webhook trigger in the daemon's folder; `execution` and `source` merge over the defaults. */
export function webhookInput(
  t: TestDaemon,
  overrides: {
    name?: string;
    enabled?: boolean;
    source?: Record<string, unknown>;
    execution?: Record<string, unknown>;
    prompt?: string;
  } = {},
): TriggerInput {
  return TriggerInput.parse({
    name: overrides.name ?? "Alerts",
    enabled: overrides.enabled ?? true,
    source: { type: "webhook", format: "alertmanager", ...overrides.source },
    execution: { cwd: t.cwd, ...overrides.execution },
    prompt: overrides.prompt ?? "Handle:\n{{payload}}",
  });
}

export async function createTrigger(client: TestClient, input: unknown): Promise<Created> {
  const created = await client.call("automation.triggers.create", { input: input as TriggerInput });
  const { trigger, secret } = result<{ trigger: { id: string }; secret: string }>(created);
  return { id: trigger.id, secret };
}

/** An Alertmanager group of one alert; `fingerprint` and `alertname` make the delivery distinct. */
export const alertBody = (alertname: string, fingerprint = "f1", status = "firing"): string =>
  JSON.stringify({
    status,
    alerts: [{ status, labels: { alertname, instance: "db1", severity: "warning" }, fingerprint }],
  });

/** `X-Pap-Signature-256` for a body under a trigger's secret. */
export const sign = (secret: string, body: string): string =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

export interface Delivery {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

/** One POST to the hook route, over HTTP on the daemon's own address; the body is sent as given. */
export async function deliver(
  t: TestDaemon,
  id: string,
  headers: Record<string, string>,
  body: string,
): Promise<Delivery> {
  const reply = await httpRequest(`${t.base}/hooks/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(reply.body) as Record<string, unknown>;
  } catch {
    // A body that is not JSON is compared by the status alone.
  }
  return { status: reply.status, json };
}

export const bearer = (secret: string): Record<string, string> => ({ authorization: `Bearer ${secret}` });

/** The daemon's database as it is now, read-only; the caller closes it. */
export function stateDb(home: string): DatabaseSync {
  return new DatabaseSync(join(home, "state.db"), { readOnly: true });
}

export function rows<T>(home: string, sql: string, ...params: Array<string | number>): T[] {
  const db = stateDb(home);
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

export const taskRows = (home: string) =>
  rows<{ id: string; state: string; reason: string | null; session_id: string | null }>(
    home,
    "SELECT id, state, reason, session_id FROM tasks ORDER BY created_at, id",
  );

/** Writes the owner's automation setting through the browser connection (compare-and-set on the stored revision). */
export async function setAutomation(client: TestClient, patch: Partial<AutomationSettings>): Promise<void> {
  const current = result<{ value: unknown; revision: number }>(
    await client.call("settings.get", { key: "automation" }),
  );
  const value = AutomationSettings.parse({ ...(current.value as object | null), ...patch });
  const written = await client.call("settings.set", {
    key: "automation",
    value,
    baseRevision: current.revision,
  });
  expect(written.ok, JSON.stringify(written)).toBe(true);
}

/** The newest journal lines of a trigger, newest first. */
export async function journalOf(client: TestClient, triggerId: string) {
  return result<{ entries: Array<{ verdict: string; count: number; detail: string | null }> }>(
    await client.call("automation.journal", { triggerId }),
  ).entries;
}
