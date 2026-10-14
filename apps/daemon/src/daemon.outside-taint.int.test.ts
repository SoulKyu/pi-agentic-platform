import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventFrame } from "@pap/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rowsOf } from "./security/testing/fixtures.ts";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";
import type { TestClient } from "./testing/ws-client.ts";

let t: TestDaemon;
let client: TestClient;
beforeEach(async () => {
  t = await startTestDaemon({ steps: [{ text: "hi" }] }, { config: { workerIdleMs: 1500 } });
  client = await t.connect(await t.login());
});
afterEach(async () => {
  client.close();
  await t.stop();
});

const ev = (frame: EventFrame) =>
  frame.event as { kind?: string; status?: string; policy?: { tainted: boolean } };
const entry = (id: string, parentId: string, message: object) =>
  `${JSON.stringify({ type: "message", id, parentId, timestamp: "2026-10-13T00:00:09.000Z", message })}\n`;

const piFile = (): string => {
  const found = readdirSync(join(t.root, "agent"), { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(t.root, "agent", name));
  if (found.length !== 1 || found[0] === undefined)
    throw new Error(`expected one Pi file, got ${found.length}`);
  return found[0];
};
const leafOf = (file: string): string => {
  const last = readFileSync(file, "utf8").trim().split("\n").at(-1) ?? "{}";
  return (JSON.parse(last) as { id: string }).id;
};
const indexed = async (q: string): Promise<void> => {
  await vi.waitFor(
    async () => {
      const reply = await client.call("search.query", { q });
      expect(reply.ok && (reply.result as { hits: unknown[] }).hits.length).toBeGreaterThan(0);
    },
    { timeout: 30_000, interval: 200 },
  );
};
it("taints a released session when tool results are appended outside pap, not for text alone (decision 75 Q5)", async () => {
  const created = await client.call("sessions.create", { cwd: t.cwd });
  const sessionId = (created as unknown as { result: { sessionId: string } }).result.sessionId;
  // One subscription for the whole test: the taint arrives as a `policy` event (a poll would open one per try).
  const opened = await client.call("subscribe.session", { sessionId });
  const sub = (opened as unknown as { result: { sub: string } }).result.sub;
  const snapshot = await client.waitForEvent((f) => f.sub === sub && ev(f).kind === "snapshot");
  expect((snapshot.event as { policy: { tainted: boolean } }).policy.tainted).toBe(false);
  const policyEvent = (tainted: boolean, after: number) =>
    client.waitForEvent(
      (f) => f.sub === sub && f.seq > after && ev(f).kind === "policy" && ev(f).policy?.tainted === tainted,
      30_000,
    );
  await client.call("sessions.prompt", { sessionId, text: "unique-opening-marker" });
  await client.waitForEvent((f) => f.sub === sub && ev(f).status === "cold", 30_000);
  await indexed("unique-opening-marker");

  const file = piFile();
  const mark = client.events.at(-1)?.seq ?? 0;
  appendFileSync(
    file,
    entry("cli-t", leafOf(file), {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      content: [{ type: "text", text: "output typed in the terminal" }],
      isError: false,
      timestamp: 4,
    }),
  );
  await policyEvent(true, mark);

  const rows = rowsOf(await client.call("audit.list", { sessionId, limit: 50 }));
  expect(rows.filter((row) => row.reason === "tainted_outside")).toMatchObject([
    { kind: "policy", actor: "system" },
  ]);

  const cleared = client.events.at(-1)?.seq ?? 0;
  expect(await client.call("policy.clearTaint", { sessionId })).toMatchObject({ ok: true });
  await policyEvent(false, cleared);
  const afterClear = client.events.at(-1)?.seq ?? 0;
  appendFileSync(
    file,
    entry("cli-a", "cli-t", {
      role: "assistant",
      content: [{ type: "text", text: "second-text-marker" }],
      timestamp: 5,
    }),
  );
  await indexed("second-text-marker");
  expect(
    client.events.some(
      (f) => f.sub === sub && f.seq > afterClear && ev(f).kind === "policy" && ev(f).policy?.tainted === true,
    ),
  ).toBe(false);
}, 90_000);
