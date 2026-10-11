import { readFileSync } from "node:fs";
import type { EventFrame } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";
import type { TestClient } from "./testing/ws-client.ts";

const budgets = JSON.parse(readFileSync(new URL("../../../budgets.json", import.meta.url), "utf8")) as {
  sessionOpenPayloadKb: number;
  idleWorkerRssMb: number;
};
const SCRIPT = {
  steps: [
    { toolCalls: [{ name: "bash", args: { command: "echo pap-int-ok" }, id: "call-1" }] },
    { text: "The command printed pap-int-ok." },
  ],
};

type StreamEvent = {
  kind?: string;
  status?: string;
  cause?: string;
  dialog?: { id: string; message?: string };
  event?: { type?: string; isError?: boolean };
};
const ev = (frame: EventFrame) => frame.event as StreamEvent;
const kind = (k: string) => (frame: EventFrame) => ev(frame).kind === k;
const pi = (type: string) => (frame: EventFrame) => ev(frame).kind === "pi" && ev(frame).event?.type === type;
const statusIs =
  (status: string, after = -1) =>
  (frame: EventFrame) =>
    kind("status")(frame) && ev(frame).status === status && frame.seq > after;

let t: TestDaemon;
beforeEach(async () => {
  t = await startTestDaemon(SCRIPT);
});
afterEach(async () => {
  await t.stop();
});

async function openSession(): Promise<{ client: TestClient; sessionId: string; cookie: string }> {
  const cookie = await t.login();
  const client = await t.connect(cookie);
  const created = await client.call("sessions.create", { cwd: t.cwd });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const sessionId = (created.result as { sessionId: string }).sessionId;
  expect((await client.call("subscribe.session", { sessionId })).ok).toBe(true);
  return { client, sessionId, cookie };
}

async function promptAndApprove(
  client: TestClient,
  sessionId: string,
  confirmed: boolean,
  after = -1,
): Promise<EventFrame> {
  expect(await client.call("sessions.prompt", { sessionId, text: "Run the check" })).toMatchObject({
    ok: true,
    result: { disposition: "started" },
  });
  const open = await client.waitForEvent((f) => kind("dialog_open")(f) && f.seq > after);
  expect(ev(open).dialog?.message).toContain("echo pap-int-ok");
  expect(
    await client.call("sessions.respondDialog", {
      sessionId,
      dialogId: ev(open).dialog?.id ?? "",
      response: { confirmed },
    }),
  ).toMatchObject({ ok: true });
  return open;
}

describe("pap daemon end to end (scripted provider)", () => {
  it("prompt → approval card → result, within the session-open and idle-RAM budgets", async () => {
    const { client, sessionId } = await openSession();
    const snapshot = await client.waitForEvent(kind("snapshot"));
    expect(Buffer.byteLength(JSON.stringify(snapshot)) / 1024).toBeLessThan(budgets.sessionOpenPayloadKb);
    const open = await promptAndApprove(client, sessionId, true);
    const toolEnd = await client.waitForEvent(pi("tool_execution_end"));
    expect(JSON.stringify(toolEnd.event)).toContain("pap-int-ok");
    await client.waitForEvent(statusIs("idle", open.seq));
    expect(
      client.events.some(
        (f) => pi("message_end")(f) && JSON.stringify(f.event).includes("The command printed pap-int-ok."),
      ),
    ).toBe(true);
    expect(t.daemon.inspect.workerRssMb(sessionId) ?? Number.POSITIVE_INFINITY).toBeLessThan(
      budgets.idleWorkerRssMb,
    );
    client.close();
  });

  it("a denied call reaches the model as an error", async () => {
    const { client, sessionId } = await openSession();
    await promptAndApprove(client, sessionId, false);
    const toolEnd = await client.waitForEvent(pi("tool_execution_end"));
    expect(ev(toolEnd).event?.isError).toBe(true);
    expect(JSON.stringify(toolEnd.event)).toContain("Denied by the user.");
    client.close();
  });

  it("resumes a second connection from a cursor without a snapshot", async () => {
    const { client, sessionId, cookie } = await openSession();
    const open = await promptAndApprove(client, sessionId, true);
    await client.waitForEvent(statusIs("idle", open.seq));
    const middle = client.events[Math.floor(client.events.length / 2)];
    if (!middle) throw new Error("no events");
    const second = await t.connect(cookie);
    expect(
      (await second.call("subscribe.session", { sessionId, after: { epoch: middle.epoch, seq: middle.seq } }))
        .ok,
    ).toBe(true);
    const first = await second.waitForEvent(() => true);
    expect(first.seq).toBe(middle.seq + 1);
    expect(kind("snapshot")(first)).toBe(false);
    second.close();
    client.close();
  });

  it("worker killed with an open approval card: card closed, cause shown, next prompt restarts on the same file", async () => {
    const { client, sessionId } = await openSession();
    expect(await client.call("sessions.prompt", { sessionId, text: "Run the check" })).toMatchObject({
      ok: true,
    });
    const open = await client.waitForEvent(kind("dialog_open"));
    const firstPid = t.daemon.inspect.workerPid(sessionId);
    process.kill(-(firstPid ?? 0), "SIGKILL");
    await client.waitForEvent((f) => kind("dialog_closed")(f) && f.seq > open.seq);
    const cold = await client.waitForEvent(statusIs("cold", open.seq));
    expect(ev(cold).cause).toContain("SIGKILL");
    await promptAndApprove(client, sessionId, true, cold.seq);
    await client.waitForEvent(
      (f) =>
        pi("message_end")(f) && f.seq > cold.seq && JSON.stringify(f.event).includes("The command printed"),
    );
    expect(t.daemon.inspect.workerPid(sessionId)).not.toBe(firstPid);
    client.close();
  });
});
