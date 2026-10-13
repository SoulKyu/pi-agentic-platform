import { describe, expect, it } from "vitest";
import { startTestDaemon } from "./harness.ts";

// Not port 9: fetch refuses the "discard" port itself ("bad port") before any connection, so the guard would never see it.
const sneaky = `export default function (pi) { pi.on("session_start", () => fetch("http://127.0.0.1:65001/").catch(() => {})); }`;

describe("test daemon", () => {
  it("fails a test whose worker tried to reach the network, even when the code swallowed the refusal (R118)", async () => {
    const t = await startTestDaemon({ steps: [{ text: "unused" }] }, { extensions: { sneaky } });
    const client = await t.connect(await t.login());
    await client.call("sessions.create", { cwd: t.cwd });
    await expect(t.stop()).rejects.toThrow("a worker tried to reach the network");
  });

  it("stops quietly when no worker tried anything", async () => {
    const t = await startTestDaemon({ steps: [{ text: "unused" }] });
    const client = await t.connect(await t.login());
    await client.call("sessions.create", { cwd: t.cwd });
    await expect(t.stop()).resolves.toBeUndefined();
  });

  it("writes agentFiles under the agent directory and hands workerEnv to the worker", async () => {
    const command = 'printenv HARNESS_MARK; cat "$PI_CODING_AGENT_DIR/nested/marker.txt"';
    const t = await startTestDaemon(
      { steps: [{ toolCalls: [{ name: "bash", args: { command }, id: "b" }] }, { text: "done" }] },
      { agentFiles: { "nested/marker.txt": "from-agent-file" }, workerEnv: { HARNESS_MARK: "zebra-42" } },
    );
    try {
      const client = await t.connect(await t.login());
      const created = await client.call("sessions.create", { cwd: t.cwd });
      if (!created.ok) throw new Error("sessions.create failed");
      const sessionId = (created.result as { sessionId: string }).sessionId;
      await client.call("subscribe.session", { sessionId });
      await client.call("sessions.prompt", { sessionId, text: "go" });
      const card = await client.waitForEvent((f) => (f.event as { kind?: string }).kind === "dialog_open");
      const dialogId = (card.event as { dialog: { id: string } }).dialog.id;
      await client.call("sessions.respondDialog", { sessionId, dialogId, response: { answer: "once" } });
      const result = await client.waitForEvent(
        (f) =>
          JSON.stringify(f.event).includes('"role":"toolResult"') &&
          JSON.stringify(f.event).includes("zebra-42"),
      );
      expect(JSON.stringify(result.event)).toContain("from-agent-file");
    } finally {
      await t.stop();
    }
  });
});
