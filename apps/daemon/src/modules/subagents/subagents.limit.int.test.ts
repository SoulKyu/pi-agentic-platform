import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { openOwner, result, rows } from "../../security/testing/automation-bed.ts";
import { markOf, waitIdle } from "../../security/testing/fixtures.ts";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";
import { drainOutboxOf } from "../../testing/usage-seam.ts";

// M11R139 (final review I2): a child whose run hits a usage limit is not resumed on its own at the reset; its parent's
// call is over, so the continuation would be unattended work whose answer goes nowhere.
const LIMIT_TEXT = "You have hit your ChatGPT usage limit (plus plan). Try again in ~1 min.";

let t: TestDaemon | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

describe("a usage-limited child (M11R139)", () => {
  it("is not resumed at the reset: its row ends failed usage_limit and no run.resume is written", async () => {
    const shift = { ms: 0 };
    const clock = { ...createSystemClock(), now: () => Date.now() + shift.ms };
    t = await startTestDaemon(
      { steps: [{ text: "unused" }] },
      { deps: { clock }, config: { maxWorkers: 4 } },
    );
    const daemon = t;
    const write = (steps: object[]) =>
      writeFileSync(join(daemon.root, "script.json"), JSON.stringify({ steps }));
    const owner = await openOwner(daemon);
    const client = owner.client;
    try {
      write([
        { toolCalls: [{ name: "subagent", args: { task: "Long job" }, id: "sa1" }] },
        { text: "Parent done." },
      ]);
      const created = await client.call("sessions.create", { cwd: daemon.cwd });
      const parentId = result<{ sessionId: string }>(created).sessionId;
      write([{ stopReason: "error", errorMessage: LIMIT_TEXT }]);
      result(await client.call("subscribe.session", { sessionId: parentId }));
      const mark = markOf(client);
      result(await client.call("sessions.prompt", { sessionId: parentId, text: "Delegate." }));
      await waitIdle(client, mark);

      const [run] = rows<{ state: string; reason: string | null; child_session_id: string }>(
        daemon.home,
        "SELECT state, reason, child_session_id FROM subagent_runs WHERE parent_session_id = ?",
        parentId,
      );
      expect(run).toMatchObject({ state: "failed", reason: "usage_limit" });
      const childId = run?.child_session_id ?? "";
      const childRuns = () =>
        rows<{ origin: string; status: string }>(
          daemon.home,
          "SELECT origin, status FROM runs WHERE session_id = ? ORDER BY started_at",
          childId,
        );
      await vi.waitFor(() => expect(childRuns()).toHaveLength(1), { timeout: 20_000 });
      expect(childRuns()[0]).toMatchObject({ origin: "subagent", status: "limited" });
      expect(
        rows(
          daemon.home,
          "SELECT id FROM outbox WHERE kind = 'run.resume' AND payload LIKE ?",
          `%${childId}%`,
        ),
      ).toEqual([]);

      shift.ms = 5 * 60_000;
      await drainOutboxOf(daemon.home)?.();
      expect(childRuns()).toHaveLength(1);
    } finally {
      client.close();
    }
  });
});
