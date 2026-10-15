import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EventFrame } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";
import type { TestClient } from "../../testing/ws-client.ts";

type StreamEvent = { kind?: string; status?: string };
const ev = (frame: EventFrame) => frame.event as StreamEvent;
const status =
  (name: string, after = -1) =>
  (frame: EventFrame) =>
    ev(frame).kind === "status" && ev(frame).status === name && frame.seq > after;

let t: TestDaemon | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

async function openSession(daemon: TestDaemon): Promise<{ client: TestClient; sessionId: string }> {
  const client = await daemon.connect(await daemon.login());
  const created = await client.call("sessions.create", { cwd: daemon.cwd });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const sessionId = (created.result as { sessionId: string }).sessionId;
  expect((await client.call("subscribe.session", { sessionId })).ok).toBe(true);
  return { client, sessionId };
}

const lines = (daemon: TestDaemon): Array<Record<string, unknown>> =>
  readFileSync(join(daemon.home, "logs", "runs.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("the runs registry in a real daemon (scripted provider)", () => {
  it("records a prompt as one completed user run with the provider's token counts, and exports it", async () => {
    t = await startTestDaemon({ steps: [{ text: "Hello from the scripted model." }] });
    const { client, sessionId } = await openSession(t);
    const prompted = await client.call("sessions.prompt", { sessionId, text: "Say hello" });
    expect(prompted).toMatchObject({ ok: true, result: { disposition: "started" } });
    const running = await client.waitForEvent(status("running"));
    await client.waitForEvent(status("idle", running.seq));
    const [line, ...rest] = await waitForLines(t, 1);
    expect(rest).toEqual([]);
    expect(line).toMatchObject({
      v: 1,
      sessionId,
      taskId: null,
      origin: "user",
      status: "completed",
      provider: "faux",
      billing: "api",
      turns: 1,
      toolCalls: 0,
      errorClass: null,
    });
    // The faux provider streams 4-character chunks: its 30-character reply is 8 output tokens. The prompt side is the
    // system prompt's size, which follows Pi's version, so it is only checked to be there and to add up.
    const tokens = (line as { tokens: Record<string, number> }).tokens;
    expect(tokens.output).toBe(8);
    expect(tokens.input).toBeGreaterThan(0);
    expect(statSync(join(t.home, "logs", "runs.jsonl")).mode & 0o777).toBe(0o600);
    const summary = await client.call("usage.summary", { range: "today" });
    expect(summary).toMatchObject({
      ok: true,
      result: {
        totals: { runs: 1, tokens: Object.values(tokens).reduce((sum, count) => sum + count, 0) },
        byOrigin: [{ origin: "user", runs: 1 }],
        byModel: [{ provider: "faux", billing: "api", runs: 1 }],
      },
    });
  });

  it("records a Stop as a cancelled run", async () => {
    t = await startTestDaemon({
      steps: [{ toolCalls: [{ name: "bash", args: { command: "env echo parked" }, id: "call-1" }] }],
    });
    const { client, sessionId } = await openSession(t);
    await client.call("sessions.prompt", { sessionId, text: "Run it" });
    await client.waitForEvent((frame) => ev(frame).kind === "dialog_open");
    expect(await client.call("sessions.abort", { sessionId })).toMatchObject({ ok: true });
    const [line] = await waitForLines(t, 1);
    expect(line).toMatchObject({ status: "cancelled", errorClass: "aborted", origin: "user", sessionId });
  });
});

async function waitForLines(daemon: TestDaemon, count: number) {
  let found: Array<Record<string, unknown>> = [];
  await vi.waitFor(
    () => {
      found = lines(daemon);
      if (found.length < count) throw new Error("not yet");
    },
    { timeout: 20_000 },
  );
  return found;
}
