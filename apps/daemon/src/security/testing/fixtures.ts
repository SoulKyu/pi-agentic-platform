import type { AuditView, EventFrame, ResponseFrame } from "@pap/contracts";
import { expect, vi } from "vitest";
import type { TestDaemon } from "../../testing/harness.ts";
import type { TestClient } from "../../testing/ws-client.ts";

// Shared by the security suite (spec C §8.1). MCP is not here: the production worker loads no MCP (M5 Task 9 ruling),
// so MCP exit criteria run in-process in packages/pi-host (host.taint.mcp*.int.test.ts).

type StreamEvent = { kind?: string; status?: string; dialog?: { id?: string } };
const streamOf = (frame: EventFrame) => frame.event as StreamEvent;

export const isDialog = (frame: EventFrame): boolean => streamOf(frame).kind === "dialog_open";

export function dialogIdOf(frame: EventFrame): string {
  const id = streamOf(frame).dialog?.id;
  if (typeof id !== "string") throw new Error("not a dialog frame");
  return id;
}

export function sessionIdOf(frame: ResponseFrame): string {
  if (!frame.ok) throw new Error(`call failed: ${JSON.stringify(frame)}`);
  return (frame.result as { sessionId: string }).sessionId;
}

export function rowsOf(frame: ResponseFrame): AuditView[] {
  if (!frame.ok) throw new Error(`call failed: ${JSON.stringify(frame)}`);
  return (frame.result as { entries: AuditView[] }).entries;
}

/** The newest stream position the client has seen: a mark taken before a prompt, for `waitIdle`. */
export const markOf = (client: TestClient): number => client.events.at(-1)?.seq ?? -1;

/** Waits for the run that started after `after` to end: a `running` status, then the `idle` that follows it. */
export async function waitIdle(client: TestClient, after: number): Promise<void> {
  const running = await client.waitForEvent((f) => streamOf(f).status === "running" && f.seq > after);
  await client.waitForEvent((f) => streamOf(f).status === "idle" && f.seq > running.seq);
}

/** Call rows of a session; polled because the worker's audit records reach the daemon a moment after the stream. */
export async function callRows(client: TestClient, sessionId: string, count: number): Promise<AuditView[]> {
  let rows: AuditView[] = [];
  await vi.waitFor(
    async () => {
      const all = rowsOf(await client.call("audit.list", { sessionId, limit: 200 }));
      rows = all.filter((row) => row.kind === "call");
      expect(rows).toHaveLength(count);
    },
    { timeout: 20_000, interval: 50 },
  );
  return rows;
}

/** SIGKILL of the worker's process group; a pid of 0 or 1 would signal far more than that. */
export function killWorkerOf(t: TestDaemon, sessionId: string): number {
  const pid = t.daemon.inspect.workerPid(sessionId);
  expect(pid).toBeGreaterThan(1);
  process.kill(-(pid ?? 0), "SIGKILL");
  return pid ?? 0;
}

/** Stage id -> every outcome that stage gave across the rows (calls and results). */
export function stagesSeen(rows: readonly AuditView[]): Record<string, string[]> {
  const seen: Record<string, string[]> = {};
  for (const verdict of rows.flatMap((row) => row.stages)) (seen[verdict.stage] ??= []).push(verdict.outcome);
  return seen;
}
