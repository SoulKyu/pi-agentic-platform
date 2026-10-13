import { request } from "node:http";
import type { AuditView, EventFrame, ResponseFrame } from "@pap/contracts";
import { expect, vi } from "vitest";
import type { HttpReply } from "../../testing/http-client.ts";
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

/**
 * The newest stream position the client has seen: a mark taken before a prompt, for `waitIdle` and the waits below.
 * Seq spaces are per channel, so this assumes one subscription per client (the suite subscribes to one session).
 */
export const markOf = (client: TestClient): number => client.events.at(-1)?.seq ?? -1;

/** Waits for the run that started after `after` to end: a `running` status, then the `idle` that follows it. */
export async function waitIdle(client: TestClient, after: number): Promise<void> {
  const running = await client.waitForEvent((f) => streamOf(f).status === "running" && f.seq > after);
  await client.waitForEvent((f) => streamOf(f).status === "idle" && f.seq > running.seq);
}

/** An idle that ends a run: the status before it was `running` (a worker starting up also reports `idle`). */
function endsARun(events: readonly EventFrame[], frame: EventFrame): boolean {
  if (streamOf(frame).status !== "idle") return false;
  const previous = events
    .slice(0, events.indexOf(frame))
    .reverse()
    .find((f) => streamOf(f).status !== undefined);
  return previous !== undefined && streamOf(previous).status === "running";
}

/**
 * The first card, or the end of the run, after `after`. A test that expects (or forbids) a card waits for this
 * instead of for a card alone: the wrong outcome fails at once with its own assertion, not after the wait for the
 * outcome that never comes.
 */
export async function firstDialogOrIdle(
  client: TestClient,
  after: number,
): Promise<{ kind: "dialog" | "idle"; frame: EventFrame }> {
  const frame = await client.waitForEvent(
    (f) => f.seq > after && (isDialog(f) || endsARun(client.events, f)),
  );
  return { kind: isDialog(frame) ? "dialog" : "idle", frame };
}

/** The card the policy raises after `after`; fails at once, naming the idle status, when the run ended without one. */
export async function nextDialog(client: TestClient, after: number): Promise<EventFrame> {
  const first = await firstDialogOrIdle(client, after);
  expect(first.kind, "the run ended without a card").toBe("dialog");
  return first.frame;
}

/** Waits for the run to end after `after` and fails at once when a card came first. */
export async function runWithoutCard(client: TestClient, after: number): Promise<void> {
  const first = await firstDialogOrIdle(client, after);
  expect(first.kind, "a card asked before the run ended").toBe("idle");
}

/** GET with the path sent exactly as written: nothing normalises it on the way (unlike `fetch` and `URL`). */
export function rawGet(port: number, path: string, headers: Record<string, string> = {}): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

/** Pi extensions: tools that return a fixed text and never open a socket. */
export const FETCH_PAGE_TOOL = `export default function (pi) {
  pi.registerTool({
    name: "fetch_page",
    label: "fetch_page",
    description: "returns a fixed page",
    parameters: { type: "object", properties: { url: { type: "string" } }, additionalProperties: true },
    execute: async () => ({ content: [{ type: "text", text: "a fixed page" }], details: {} }),
  });
}
`;

/** An extension tool `lookup` (external by default, M5R39) that returns `reply`. */
export const lookupTool = (reply: string): string => `export default function (pi) {
  pi.registerTool({
    name: "lookup",
    label: "lookup",
    description: "looks something up",
    parameters: { type: "object", properties: { q: { type: "string" } }, additionalProperties: true },
    execute: async () => ({ content: [{ type: "text", text: ${JSON.stringify(reply)} }], details: {} }),
  });
}
`;

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
