import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";

const budgets = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../../budgets.json", import.meta.url)), "utf8"),
) as { scannerLatencyMs: number };

let t: TestDaemon;
beforeEach(async () => {
  t = await startTestDaemon({ steps: [] });
});
afterEach(async () => {
  await t.stop();
});

const kindOf = (frame: { event: unknown }) => (frame.event as { kind?: string }).kind;

/**
 * The folder the CLI writes this test's sessions in, under the daemon's temporary agent folder. The SDK's
 * `getDefaultSessionDir` is not exported by the pinned package, so its naming (`--<cwd with separators as ->--`) is
 * spelled here; the folder is always passed to `SessionManager` explicitly, never derived from `~/.pi/agent`.
 */
function sessionFolder(): string {
  const folder = join(
    t.root,
    "agent",
    "sessions",
    `--${t.cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
  );
  expect(folder.startsWith(t.root)).toBe(true);
  mkdirSync(folder, { recursive: true });
  return folder;
}

/** A session written exactly as the `pi` CLI writes it: Pi's own session manager, in the daemon's agent folder. */
function writeCliSession(text: string): string {
  const manager = SessionManager.create(t.cwd, sessionFolder());
  manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  expect(manager.getSessionFile()?.startsWith(t.root)).toBe(true);
  return manager.getSessionId();
}

it("a session the pi CLI creates after the install is on the shell stream within its budget, and searchable", async () => {
  const client = await t.connect(await t.login());
  expect(await client.call("subscribe.shell", {})).toMatchObject({ ok: true });
  await client.waitForEvent((frame) => kindOf(frame) === "snapshot", 10_000);
  const started = performance.now();
  writeCliSession("hello from the pi cli about kubernetes");
  const event = await client.waitForEvent(
    (frame) =>
      kindOf(frame) === "session" && (frame.event as { session: { cwd: string } }).session.cwd === t.cwd,
    budgets.scannerLatencyMs,
  );
  const elapsed = Math.round(performance.now() - started);
  console.log(
    `scanner: a CLI session reached the shell stream after ${elapsed} ms (budget ${budgets.scannerLatencyMs})`,
  );
  expect(elapsed).toBeLessThanOrEqual(budgets.scannerLatencyMs);
  const sessionId = (event.event as { session: { id: string } }).session.id;
  const answer = await client.call("search.query", { q: "kubernetes pi cli" });
  expect(answer).toMatchObject({ ok: true });
  expect(
    (answer as unknown as { result: { hits: Array<{ sessionId: string }> } }).result.hits.map(
      (hit) => hit.sessionId,
    ),
  ).toEqual([sessionId]);
});

/** Pi's file format with a header dated `timestamp` (the SDK always stamps "now", so this one is written by hand). */
function writeOldSession(timestamp: string, text: string): string {
  const folder = sessionFolder();
  mkdirSync(folder, { recursive: true });
  const header = { type: "session", version: 3, id: randomUUID(), timestamp, cwd: t.cwd };
  const entry = {
    type: "message",
    id: "a1b2c3d4",
    parentId: null,
    timestamp,
    message: { role: "user", content: text, timestamp: Date.parse(timestamp) },
  };
  const path = join(folder, `old_${header.id}.jsonl`);
  writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);
  return path;
}

it("never shows a session created before the install, once it has been read (M4R137)", async () => {
  const client = await t.connect(await t.login());
  await client.call("subscribe.shell", {});
  const oldPath = writeOldSession("2020-01-01T00:00:00.000Z", "an old session about kubernetes");
  writeCliSession("a new one");
  await client.waitForEvent((frame) => kindOf(frame) === "session", budgets.scannerLatencyMs);
  // The old file was processed and excluded, not merely not reached yet.
  const index = new DatabaseSync(join(t.home, "search.db"), { readOnly: true });
  try {
    await vi.waitFor(
      () =>
        expect(index.prepare("SELECT state FROM files WHERE path = ?").get(oldPath)).toEqual({
          state: "excluded",
        }),
      { timeout: budgets.scannerLatencyMs },
    );
  } finally {
    index.close();
  }
  const sessions = client.events.filter((frame) => kindOf(frame) === "session");
  expect(new Set(sessions.map((frame) => (frame.event as { session: { id: string } }).session.id)).size).toBe(
    1,
  );
  const answer = await client.call("search.query", { q: "old session" });
  expect((answer as unknown as { result: { hits: unknown[] } }).result.hits).toEqual([]);
});
