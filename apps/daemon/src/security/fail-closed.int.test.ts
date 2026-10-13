import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "../testing/harness.ts";
import { callRows, FETCH_PAGE_TOOL, markOf, runWithoutCard, sessionIdOf } from "./testing/fixtures.ts";

// Spec C §8.1, class "fail closed", daemon half: real HTTP, /ws, SQLite and a pi-host worker on the scripted model.
// The worker half (a malformed policy update, invalid rules at start) is packages/pi-host/src/host.failclosed.int.test.ts.

// A user extension loads before pap-policy (the policy is always last, ADR 0002) and makes every write's input
// unstatable: the policy cannot describe the call, so it blocks it.
const POISON =
  'export default (pi) => pi.on("tool_call", (event) => { if (event.toolName === "write") event.input.size = 10n; });';
/** A test-only write beside the running daemon: the single-writer rule is about the product. */
function corruptPolicySettings(t: TestDaemon): void {
  const db = new DatabaseSync(join(t.home, "state.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const users = db.prepare("SELECT id FROM users").all() as Array<{ id: string }>;
    expect(users).toHaveLength(1);
    // A deny pattern holding NUL: the schema refuses it, so the stored document no longer parses.
    const value = JSON.stringify({ defaultMode: "full-access", denylist: ["a\u0000b"] });
    db.prepare(
      "INSERT OR REPLACE INTO policy_settings (owner_id, value, revision, updated_at) VALUES (?, ?, 1, 0)",
    ).run(users[0]?.id ?? "", value);
  } finally {
    db.close();
  }
}

describe("security: fail closed (daemon)", () => {
  it("blocks a call whose input an earlier extension made unreadable, and the call never runs", async () => {
    const t = await startTestDaemon(
      {
        steps: [
          { toolCalls: [{ name: "write", args: { path: "out.txt", content: "x" }, id: "w" }] },
          { text: "done" },
        ],
      },
      { extensions: { poison: POISON } },
    );
    try {
      const client = await t.connect(await t.login());
      const sessionId = sessionIdOf(await client.call("sessions.create", { cwd: t.cwd }));
      await client.call("subscribe.session", { sessionId });
      const mark = markOf(client);
      await client.call("sessions.prompt", { sessionId, text: "write it" });
      await runWithoutCard(client, mark);
      const calls = await callRows(client, sessionId, 1);
      expect(calls[0]).toMatchObject({
        tool: "write",
        toolCallId: "w",
        decision: "block",
        reason: "evaluation error",
        args: "[unreadable input]",
      });
      expect(existsSync(join(t.cwd, "out.txt"))).toBe(false);
      // The model was told the call failed: the stream carries an error result, not a file.
      expect(
        client.events.some(
          (f) =>
            JSON.stringify(f.event).includes('"role":"toolResult"') &&
            JSON.stringify(f.event).includes("could not evaluate this call"),
        ),
      ).toBe(true);
    } finally {
      await t.stop();
    }
  }, 60_000);

  it("gives workers the restrictive settings (supervised, no allowed host) when the stored settings no longer parse", async () => {
    const t = await startTestDaemon(
      {
        steps: [
          { toolCalls: [{ name: "fetch_page", args: { url: "https://example.com" }, id: "f" }] },
          { text: "done" },
        ],
      },
      { extensions: { fetch: FETCH_PAGE_TOOL } },
    );
    try {
      const cookie = await t.login();
      corruptPolicySettings(t);
      const client = await t.connect(cookie);
      // The owner can still see that the document is unreadable and save over it.
      expect(await client.call("policy.getSettings", {})).toMatchObject({
        ok: true,
        result: { value: null, revision: 1 },
      });
      const sessionId = sessionIdOf(await client.call("sessions.create", { cwd: t.cwd }));
      await client.call("subscribe.session", { sessionId });
      const snapshot = await client.waitForEvent((f) => (f.event as { kind?: string }).kind === "snapshot");
      expect((snapshot.event as { policy: unknown }).policy).toEqual({
        mode: "supervised",
        explicit: false,
        tainted: false,
      });
      const mark = markOf(client);
      await client.call("sessions.prompt", { sessionId, text: "fetch" });
      // Fails at once, with this assertion, if the unreadable document gave the defaults and so a card.
      await runWithoutCard(client, mark);
      const calls = await callRows(client, sessionId, 1);
      expect(calls[0]).toMatchObject({ tool: "fetch_page", toolCallId: "f", decision: "block" });
      expect(calls[0]?.stages.find((verdict) => verdict.stage === "02")).toMatchObject({
        outcome: "block",
        reason: "web host not allowed: example.com",
      });
    } finally {
      await t.stop();
    }
  }, 60_000);
});
