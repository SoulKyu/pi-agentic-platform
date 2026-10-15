import { type EventFrame, TriggerInput } from "@pap/contracts";
import { afterEach, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";
import { httpRequest } from "../../testing/http-client.ts";

type TaskEvent = { kind: string; task?: { id: string; state: string; origin: string } };

let t: TestDaemon | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

it("takes a real delivery on /hooks: 202 and a task, a repeat is 409 dedup, a wrong secret is 401", async () => {
  t = await startTestDaemon({ steps: [{ text: "Disk checked." }] });
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
  expect((await client.call("subscribe.tasks", {})).ok).toBe(true);
  await client.waitForEvent((frame) => (frame.event as TaskEvent).kind === "snapshot");

  const body = JSON.stringify({
    status: "firing",
    alerts: [{ status: "firing", labels: { alertname: "DiskFull", instance: "db1" }, fingerprint: "f1" }],
  });
  const post = (authorization: string) =>
    httpRequest(`${t?.base}/hooks/${trigger.id}`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body,
    });

  const accepted = await post(`Bearer ${secret}`);
  expect(accepted.status).toBe(202);
  const taskId = (JSON.parse(accepted.body) as { taskId: string }).taskId;
  const queued = await client.waitForEvent(
    (frame: EventFrame) =>
      (frame.event as TaskEvent).kind === "task" && (frame.event as TaskEvent).task?.id === taskId,
  );
  expect((queued.event as TaskEvent).task).toMatchObject({ id: taskId, origin: "webhook" });

  const again = await post(`Bearer ${secret}`);
  expect([again.status, JSON.parse(again.body)]).toEqual([409, { reason: "dedup" }]);
  expect((await post("Bearer wrong")).status).toBe(401);
}, 60_000);
