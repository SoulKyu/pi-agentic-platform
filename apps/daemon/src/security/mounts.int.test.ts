import { TriggerInput } from "@pap/contracts";
import { afterEach, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "../testing/harness.ts";
import { httpRequest } from "../testing/http-client.ts";

const TOKEN = "metrics-Token_0123456789abcdefghijklmnop";

let t: TestDaemon | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

it("serves /hooks (its own secret, no cookie) and /metrics (its own bearer) from one booted daemon", async () => {
  t = await startTestDaemon({ steps: [{ text: "hi" }] }, { config: { metricsToken: TOKEN } });
  const cookie = await t.login();
  await t.confirmStepUp(cookie);
  const client = await t.connect(cookie);
  const created = await client.call("automation.triggers.create", {
    input: TriggerInput.parse({
      name: "Alerts",
      enabled: true,
      source: { type: "webhook", format: "alertmanager" },
      execution: { cwd: t.cwd },
      prompt: "Handle: {{payload}}",
    }),
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const { trigger, secret } = created.result as { trigger: { id: string }; secret: string };
  client.close();

  const hook = await httpRequest(`${t.base}/hooks/${trigger.id}`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({
      status: "firing",
      alerts: [{ status: "firing", labels: { alertname: "DiskFull" }, fingerprint: "f1" }],
    }),
  });
  const metrics = await httpRequest(`${t.base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
  expect([hook.status, metrics.status]).toEqual([202, 200]);
  expect(metrics.body).toContain("pap_");
  expect((await httpRequest(`${t.base}/metrics`)).status).toBe(401);
  expect(
    (
      await httpRequest(`${t.base}/hooks/${trigger.id}`, {
        method: "POST",
        headers: { authorization: "Bearer x" },
      })
    ).status,
  ).toBe(401);
}, 60_000);
