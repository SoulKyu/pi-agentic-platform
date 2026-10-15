import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type EventFrame, TriggerInput } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireManualOf } from "../../testing/m10-seam.ts";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";
import type { TestClient } from "../../testing/ws-client.ts";

type TaskEvent = {
  kind: string;
  task?: { id: string; state: string; sessionId: string | null; origin: string };
};
const task =
  (state: string) =>
  (frame: EventFrame): boolean => {
    const event = frame.event as TaskEvent;
    return event.kind === "task" && event.task?.state === state;
  };

let t: TestDaemon | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

async function openBoard(daemon: TestDaemon): Promise<{ client: TestClient; triggerId: string }> {
  const cookie = await daemon.login();
  await daemon.confirmStepUp(cookie);
  const client = await daemon.connect(cookie);
  const created = await client.call("automation.triggers.create", {
    input: TriggerInput.parse({
      name: "Nightly check",
      source: { type: "manual" },
      execution: { cwd: daemon.cwd },
      prompt: "Summarise the repository for {{trigger}}.",
    }),
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const triggerId = (created.result as { trigger: { id: string } }).trigger.id;
  expect((await client.call("subscribe.tasks", {})).ok).toBe(true);
  await client.waitForEvent((frame) => (frame.event as TaskEvent).kind === "snapshot");
  return { client, triggerId };
}

describe("the runner in a real daemon (scripted provider)", () => {
  it("runs a manual fire: queued, running with a session whose first message is the rendered prompt, then done", async () => {
    t = await startTestDaemon({ steps: [{ text: "The repository is empty." }] });
    const { client, triggerId } = await openBoard(t);

    const fired = fireManualOf(t.home)?.(triggerId);
    expect(fired?.verdict).toBe("fired");

    const queued = await client.waitForEvent(task("queued"));
    const taskId = (queued.event as TaskEvent).task?.id as string;
    const running = await client.waitForEvent(task("running"));
    const sessionId = (running.event as TaskEvent).task?.sessionId as string;
    expect(sessionId).toMatch(/\S/);
    await client.waitForEvent(task("done"));

    const kinds = client.events
      .map((frame) => frame.event as TaskEvent)
      .filter((event) => event.kind === "task")
      .map((event) => event.task?.state);
    expect(kinds).toEqual(["queued", "running", "done"]);

    expect((await client.call("subscribe.session", { sessionId })).ok).toBe(true);
    const snapshot = await client.waitForEvent(
      (frame) => (frame.event as { kind: string }).kind === "snapshot" && frame.sub !== queued.sub,
    );
    const rows = (snapshot.event as { rows: Array<{ message: { role?: string; content?: unknown } }> }).rows;
    const first = rows.find((row) => row.message.role === "user");
    expect(JSON.stringify(first?.message.content)).toContain("Summarise the repository for Nightly check.");

    await vi.waitFor(
      () => {
        const lines = readFileSync(join(t?.home ?? "", "logs", "runs.jsonl"), "utf8")
          .trimEnd()
          .split("\n");
        const line = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
        expect(line).toMatchObject({ taskId, origin: "manual", status: "completed", sessionId });
      },
      { timeout: 20_000 },
    );
  }, 60_000);

  it("refuses to cancel or retry a finished task: conflict", async () => {
    t = await startTestDaemon({ steps: [{ text: "First." }, { text: "Second." }] });
    const { client, triggerId } = await openBoard(t);
    fireManualOf(t.home)?.(triggerId);
    const done = await client.waitForEvent(task("done"));
    const taskId = (done.event as TaskEvent).task?.id as string;
    const cancelled = await client.call("automation.tasks.cancel", { taskId });
    expect(cancelled).toMatchObject({ ok: false, error: { code: "conflict" } });
    // A finished task is not retried; only failed, interrupted or cancelled ones are.
    const refused = await client.call("automation.tasks.retry", { taskId });
    expect(refused).toMatchObject({ ok: false, error: { code: "conflict" } });
  }, 60_000);
});
