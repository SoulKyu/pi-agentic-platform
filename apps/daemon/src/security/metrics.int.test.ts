import { TriggerInput } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "../testing/harness.ts";
import { httpRequest } from "../testing/http-client.ts";

// Spec C §4.4: `/metrics` has its own bearer token. Off unless PAP_METRICS_TOKEN is set; never a cookie, never a pap token.
const TOKEN = "metrics-Token_0123456789abcdefghijklmnop";
const TRIGGER_NAME = 'evil"} pap_x 1';

let t: TestDaemon | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});
const scrape = (daemon: TestDaemon, headers: Record<string, string> = {}) =>
  httpRequest(`${daemon.base}/metrics`, { headers });

describe("security: /metrics", () => {
  it("answers 404 like any reserved path when no token is configured, whatever the header", async () => {
    t = await startTestDaemon({ steps: [{ text: "hi" }] });
    const bare = await scrape(t);
    const bearer = await scrape(t, { authorization: `Bearer ${TOKEN}` });
    expect([bare.status, bearer.status]).toEqual([404, 404]);
    expect(JSON.parse(bare.body)).toEqual({ error: { code: "not_found" } });
    expect(bearer.body).toBe(bare.body);
  });

  it("answers 401 with a challenge and no-store for a missing, wrong or lookalike bearer", async () => {
    t = await startTestDaemon({ steps: [{ text: "hi" }] }, { config: { metricsToken: TOKEN } });
    for (const authorization of [undefined, "Bearer wrong", `Bearer ${TOKEN}x`, TOKEN, `Basic ${TOKEN}`]) {
      const reply = await scrape(t, authorization === undefined ? {} : { authorization });
      expect(reply.status).toBe(401);
      expect(reply.headers["www-authenticate"]).toBe("Bearer");
      expect(reply.headers["cache-control"]).toBe("no-store");
      expect(reply.body).not.toContain("pap_");
    }
  });

  it("refuses a browser session cookie and a pap token", async () => {
    t = await startTestDaemon({ steps: [{ text: "hi" }] }, { config: { metricsToken: TOKEN } });
    const cookie = await t.login();
    expect((await scrape(t, { cookie })).status).toBe(401);
    await t.confirmStepUp(cookie);
    const owner = await t.connect(cookie);
    const created = await owner.call("auth.tokens.create", {
      name: "ci",
      permissions: ["sessions:read"],
      expiresInDays: 7,
    });
    if (!created.ok) throw new Error(`token create failed: ${created.error.code}`);
    owner.close();
    const value = (created.result as { value: string }).value;
    expect((await scrape(t, { authorization: `Bearer ${value}` })).status).toBe(401);
  });

  it("serves the text format to the right bearer and holds no session id, trigger name or path", async () => {
    t = await startTestDaemon({ steps: [{ text: "hi" }] }, { config: { metricsToken: TOKEN } });
    const cookie = await t.login();
    await t.confirmStepUp(cookie);
    const owner = await t.connect(cookie);
    const input = TriggerInput.parse({
      name: TRIGGER_NAME,
      source: { type: "webhook" },
      execution: { cwd: t.cwd },
      prompt: "p",
    });
    const trigger = await owner.call("automation.triggers.create", { input });
    if (!trigger.ok) throw new Error(`trigger create failed: ${trigger.error.code}`);
    const session = await owner.call("sessions.create", { cwd: t.cwd });
    if (!session.ok) throw new Error(`session create failed: ${session.error.code}`);
    const sessionId = (session.result as { sessionId: string }).sessionId;
    owner.close();

    const reply = await scrape(t, { authorization: `Bearer ${TOKEN}` });
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(reply.body).toContain("# TYPE pap_tasks gauge");
    expect(reply.body).toContain("pap_workers_max 4");
    expect(reply.body).toContain("process_resident_memory_bytes ");
    for (const leak of [TRIGGER_NAME, "evil", sessionId, t.cwd, t.home, TOKEN, "u1"]) {
      expect(reply.body).not.toContain(leak);
    }
    for (const line of reply.body.split("\n")) {
      expect(line).toMatch(
        /^(# (HELP|TYPE) [a-z_:]+ .+|[a-z_:]+(\{[a-z_]+="[A-Za-z0-9._:/@+-]+"(,[a-z_]+="[A-Za-z0-9._:/@+-]+")*\})? [0-9.e+-]+|)$/,
      );
    }
  });

  it("counts a fire and a refusal in pap_trigger_fires_total, with closed labels only", async () => {
    t = await startTestDaemon({ steps: [{ text: "hi" }] }, { config: { metricsToken: TOKEN } });
    const cookie = await t.login();
    await t.confirmStepUp(cookie);
    const owner = await t.connect(cookie);
    const input = TriggerInput.parse({
      name: TRIGGER_NAME,
      source: { type: "webhook" },
      execution: { cwd: t.cwd },
      prompt: "p",
    });
    const created = await owner.call("automation.triggers.create", { input });
    if (!created.ok) throw new Error(`trigger create failed: ${created.error.code}`);
    const triggerId = (created.result as { trigger: { id: string } }).trigger.id;
    const fired = await owner.call("automation.fire", { triggerId });
    if (!fired.ok) throw new Error(`fire failed: ${fired.error.code}`);
    owner.close();
    const refused = await httpRequest(`${t.base}/hooks/${triggerId}`, {
      method: "POST",
      headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      body: "{}",
    });
    expect(refused.status).toBe(401);

    const reply = await scrape(t, { authorization: `Bearer ${TOKEN}` });
    expect(reply.body).toContain("# TYPE pap_trigger_fires_total counter");
    const lines = reply.body.split("\n").filter((line) => line.startsWith("pap_trigger_fires_total{"));
    expect(lines).toEqual([
      'pap_trigger_fires_total{source="manual",verdict="fired"} 1',
      'pap_trigger_fires_total{source="webhook",verdict="unauthorized"} 1',
    ]);
    for (const leak of [triggerId, TRIGGER_NAME]) expect(reply.body).not.toContain(leak);
  });
});
