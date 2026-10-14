import { existsSync, linkSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EventFrame } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";
import type { TestClient } from "../../testing/ws-client.ts";

// A real daemon, a real helper process and the scripted sign-in provider: nothing reaches a real provider or ~/.pi.
const SCRIPT = { steps: [{ text: "hi" }] };
const CODE = "MANUAL-CODE-7731-ZETA";
const KEY = "sk-cerebras-SECRET-KEY-9921";
const PROVIDER = "scripted-auth";
const WAIT = { timeout: 30_000 };

const authFile = (t: TestDaemon) => join(t.root, "agent", "auth.json");
const readAuth = (t: TestDaemon) => JSON.parse(readFileSync(authFile(t), "utf8")) as Record<string, unknown>;

interface Wire {
  readonly kind: string;
  readonly promptId?: string;
  readonly ok?: boolean;
  readonly code?: string;
  readonly url?: string;
}
function loginEvents(client: TestClient, sub: string): Wire[] {
  return client.events
    .filter((frame: EventFrame) => frame.sub === sub)
    .flatMap((frame) => {
      const event = frame.event as Wire & { events?: Wire[] };
      return event.kind === "snapshot" ? (event.events ?? []) : [event];
    });
}
async function waitFor(client: TestClient, sub: string, kind: string): Promise<Wire> {
  await vi.waitFor(() => expect(loginEvents(client, sub).some((e) => e.kind === kind)).toBe(true), WAIT);
  return loginEvents(client, sub).find((e) => e.kind === kind) as Wire;
}
async function session(t: TestDaemon) {
  const cookie = await t.login();
  return { cookie, client: await t.connect(cookie) };
}
async function startFlow(
  t: TestDaemon,
  cookie: string,
  client: TestClient,
  provider: string,
  method: string,
) {
  await t.confirmStepUp(cookie);
  const started = await client.call("models.login", { provider, method: method as "oauth" });
  if (!started.ok) throw new Error(`login failed: ${started.error.code}`);
  const flowId = (started.result as { flowId: string }).flowId;
  const subscribed = await client.call("subscribe.login", { flowId });
  if (!subscribed.ok) throw new Error(`subscribe failed: ${subscribed.error.code}`);
  return { flowId, sub: (subscribed.result as { sub: string }).sub };
}
/** Everything the daemon keeps in SQLite: each table as text, and the raw bytes of the database files. */
function databaseText(t: TestDaemon): string {
  const db = new DatabaseSync(join(t.home, "state.db"), { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>;
    const dump = tables.map(({ name }) =>
      JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all(), (_k, v: unknown) =>
        typeof v === "bigint"
          ? v.toString()
          : v instanceof Uint8Array
            ? Buffer.from(v).toString("latin1")
            : v,
      ),
    );
    return dump.join("\n");
  } finally {
    db.close();
  }
}
const rawBytes = (t: TestDaemon): string =>
  ["state.db", "state.db-wal"]
    .map((name) => join(t.home, name))
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path).toString("latin1"))
    .join("\n");

describe("provider sign-in through a real daemon and helper", () => {
  it("signs in with OAuth after a step-up, keeps every secret out of the log, the audit and the receipts", async () => {
    const { logger, lines } = captureLogger();
    const t = await startTestDaemon(SCRIPT, { deps: { logger } });
    try {
      const { cookie, client } = await session(t);
      // Owner c3: without the password step-up, neither a sign-in nor a key is accepted.
      expect(await client.call("models.login", { provider: PROVIDER, method: "oauth" })).toMatchObject({
        ok: false,
        error: { code: "step_up_required" },
      });
      expect(await client.call("models.setApiKey", { provider: "cerebras", key: KEY })).toMatchObject({
        ok: false,
        error: { code: "step_up_required" },
      });
      expect(existsSync(authFile(t))).toBe(false);

      const { flowId, sub } = await startFlow(t, cookie, client, PROVIDER, "oauth");
      const link = await waitFor(client, sub, "auth_url");
      expect(link.url).toBe("https://auth.scripted.test/authorize?state=scripted");
      const prompt = await waitFor(client, sub, "prompt");
      expect(prompt.promptId).toBeTruthy();
      expect(
        await client.call("models.loginAnswer", { flowId, promptId: prompt.promptId as string, value: CODE }),
      ).toMatchObject({ ok: true, result: { ok: true } });
      expect(await waitFor(client, sub, "done")).toEqual({ kind: "done", ok: true });

      const stored = readAuth(t)[PROVIDER] as Record<string, unknown>;
      expect(stored).toMatchObject({ type: "oauth", access: `access-${CODE}` });
      expect(statSync(authFile(t)).mode & 0o777).toBe(0o600);

      expect(await client.call("models.setApiKey", { provider: "cerebras", key: KEY })).toEqual(
        expect.objectContaining({ ok: true, result: { ok: true } }),
      );
      expect(readAuth(t).cerebras).toEqual({ type: "api_key", key: KEY });
      expect(statSync(authFile(t)).mode & 0o777).toBe(0o600);

      // The audit says who signed in where, never what.
      const audit = await client.call("audit.list", {});
      expect(audit.ok).toBe(true);
      const rows = (
        audit as { result: { entries: Array<{ reason: string | null; detail: unknown }> } }
      ).result.entries
        .filter((entry) => entry.reason?.startsWith("provider_"))
        .map((entry) => ({ reason: entry.reason, detail: entry.detail }));
      expect(rows).toEqual(
        expect.arrayContaining([
          { reason: "provider_signed_in", detail: { provider: PROVIDER, method: "oauth" } },
          { reason: "provider_key_set", detail: { provider: "cerebras" } },
        ]),
      );

      expect(await client.call("models.logout", { provider: "cerebras" })).toMatchObject({ ok: true });
      expect(readAuth(t).cerebras).toBeUndefined();
      expect(readAuth(t)[PROVIDER]).toBeDefined();

      for (const secret of [CODE, KEY, `access-${CODE}`, `refresh-${CODE}`]) {
        expect(JSON.stringify(lines), `log: ${secret}`).not.toContain(secret);
        expect(databaseText(t), `tables: ${secret}`).not.toContain(secret);
        expect(rawBytes(t), `files: ${secret}`).not.toContain(secret);
      }
      expect(databaseText(t)).toContain("provider_key_set");
      expect(databaseText(t)).toContain("models.setApiKey");
      client.close();
    } finally {
      await t.stop();
    }
  }, 120_000);

  it("ends a declined flow with done ok:false and leaves auth.json alone", async () => {
    const t = await startTestDaemon(SCRIPT);
    try {
      const { cookie, client } = await session(t);
      const { flowId, sub } = await startFlow(t, cookie, client, PROVIDER, "oauth");
      await waitFor(client, sub, "prompt");
      expect(await client.call("models.loginCancel", { flowId })).toMatchObject({ ok: true });
      expect(await waitFor(client, sub, "done")).toEqual({ kind: "done", ok: false });
      expect(existsSync(authFile(t))).toBe(false);
      // Cancelling again is quiet; another flow for the same provider may start.
      expect(await client.call("models.loginCancel", { flowId })).toMatchObject({ ok: true });
      client.close();
    } finally {
      await t.stop();
    }
  }, 120_000);

  it("reports a method the provider lacks as a failed flow, not a stored credential", async () => {
    const t = await startTestDaemon(SCRIPT);
    try {
      const { cookie, client } = await session(t);
      const { sub } = await startFlow(t, cookie, client, "cerebras", "oauth");
      expect(await waitFor(client, sub, "done")).toEqual({ kind: "done", ok: false, code: "bad_request" });
      expect(existsSync(authFile(t))).toBe(false);
      client.close();
    } finally {
      await t.stop();
    }
  }, 120_000);

  it("refuses to write a hard-linked auth.json with its own fixed code, and changes neither name", async () => {
    const t = await startTestDaemon(SCRIPT);
    try {
      const { cookie, client } = await session(t);
      const text = JSON.stringify({ groq: { type: "api_key", key: "old" } });
      writeFileSync(authFile(t), text, { mode: 0o600 });
      linkSync(authFile(t), join(t.root, "agent", "auth.twin"));
      await t.confirmStepUp(cookie);
      expect(await client.call("models.setApiKey", { provider: "cerebras", key: KEY })).toMatchObject({
        ok: false,
        error: { code: "config_hard_link" },
      });
      expect(await client.call("models.logout", { provider: "groq" })).toMatchObject({
        ok: false,
        error: { code: "config_hard_link" },
      });
      expect(readFileSync(authFile(t), "utf8")).toBe(text);
      expect(readFileSync(join(t.root, "agent", "auth.twin"), "utf8")).toBe(text);
      client.close();
    } finally {
      await t.stop();
    }
  }, 120_000);

  it("answers a token forbidden on every sign-in method, and cannot mint one with pi:admin", async () => {
    const t = await startTestDaemon(SCRIPT);
    try {
      const { cookie, client } = await session(t);
      await t.confirmStepUp(cookie);
      expect(
        await client.call("auth.tokens.create", {
          name: "bad",
          permissions: ["pi:admin" as never],
          expiresInDays: 7,
        }),
      ).toMatchObject({ ok: false, error: { code: "bad_request" } });
      const minted = await client.call("auth.tokens.create", {
        name: "ci",
        permissions: ["sessions:read", "settings:operate", "audit:read"] as never,
        expiresInDays: 7,
      });
      const value = (minted as { result: { value: string } }).result.value;
      const bot = await t.connectBearer(value);
      const calls = [
        bot.call("models.login", { provider: PROVIDER, method: "oauth" }),
        bot.call("models.loginAnswer", { flowId: "f", promptId: "p", value: "x" }),
        bot.call("models.loginCancel", { flowId: "f" }),
        bot.call("models.cancelLogin", { provider: PROVIDER }),
        bot.call("subscribe.login", { flowId: "f" }),
        bot.call("models.setApiKey", { provider: "cerebras", key: KEY }),
        bot.call("models.logout", { provider: "cerebras" }),
      ];
      for (const reply of await Promise.all(calls))
        expect(reply).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(existsSync(authFile(t))).toBe(false);
      bot.close();
      client.close();
    } finally {
      await t.stop();
    }
  }, 120_000);
});
