import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_POLICY_SETTINGS } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { startTestDaemon } from "../testing/harness.ts";
import {
  dialogIdOf,
  FETCH_PAGE_TOOL,
  firstDialogOrIdle,
  lookupTool,
  markOf,
  rowsOf,
  sessionIdOf,
  stagesSeen,
} from "./testing/fixtures.ts";

// Spec C §8.1 and §5.1: every stage that decides or acts leaves a line. One session goes through all of them. MCP is an
// extension tool here (the production worker loads no MCP until M7): an external read, so stage 07 acts on its result.
const TOKEN = "ghp_auditstages_0123456789";

describe("security: an audit line for every stage (daemon)", () => {
  it("leaves a line for every stage, 00 to 07, through the whole daemon", async () => {
    const t = await startTestDaemon(
      {
        steps: [
          { toolCalls: [{ name: "read", args: { path: "a.txt" }, id: "c1" }] },
          { toolCalls: [{ name: "bash", args: { command: "printenv GITHUB_TOKEN" }, id: "c2" }] },
          { toolCalls: [{ name: "lookup", args: { q: "x" }, id: "c3" }] },
          { toolCalls: [{ name: "fetch_page", args: { url: "https://evil.test/x" }, id: "c4" }] },
          // Harmless if a regression let it run: the command does not exist (M5R104, RT-17).
          { toolCalls: [{ name: "bash", args: { command: "pap-test-blocked now" }, id: "c5" }] },
          { text: "done" },
        ],
      },
      {
        agentFiles: {
          "extensions/lookup.js": lookupTool("external text"),
          "extensions/fetch.js": FETCH_PAGE_TOOL,
        },
        workerEnv: { GITHUB_TOKEN: TOKEN },
      },
    );
    try {
      writeFileSync(join(t.cwd, "a.txt"), "hello");
      const client = await t.connect(await t.login());
      expect(
        await client.call("policy.setSettings", {
          value: {
            ...DEFAULT_POLICY_SETTINGS,
            denylist: ["pap-test-blocked *"],
            allowHosts: ["example.com"],
          },
          baseRevision: 0,
        }),
      ).toMatchObject({ ok: true });
      const sessionId = sessionIdOf(await client.call("sessions.create", { cwd: t.cwd }));
      await client.call("subscribe.session", { sessionId });
      const mark = markOf(client);
      await client.call("sessions.prompt", { sessionId, text: "go" });
      // c2 (a command) and c3 (an external tool, not yet tainted) ask once each; nothing else may.
      const asked: string[] = [];
      for (let after = mark; ;) {
        const next = await firstDialogOrIdle(client, after);
        if (next.kind === "idle") break;
        after = next.frame.seq;
        asked.push(
          (next.frame.event as { dialog: { message: string } }).dialog.message.split("\n").at(-1) ?? "",
        );
        await client.call("sessions.respondDialog", {
          sessionId,
          dialogId: dialogIdOf(next.frame),
          response: { answer: "once" },
        });
      }
      expect(asked).toEqual(["bash: printenv GITHUB_TOKEN", 'lookup: {"q":"x"}']);

      const rows = rowsOf(await client.call("audit.list", { sessionId, limit: 200 }));
      const seen = stagesSeen(rows);
      expect(Object.keys(seen).sort()).toEqual(["00", "01", "02", "03", "04", "05", "06", "07"]);
      expect(seen).toMatchObject({ "00": ["pass"], "05": ["skip"] });
      const atLeast: Record<string, string[]> = {
        "01": ["block", "pass", "skip"],
        "02": ["block", "pass", "skip"],
        "03": ["allow", "ask", "skip"],
        "04": ["pass", "skip"],
        "06": ["acted", "pass"],
        "07": ["acted", "pass"],
      };
      for (const [stage, outcomes] of Object.entries(atLeast)) {
        expect(seen[stage], `stage ${stage}`).toEqual(expect.arrayContaining(outcomes));
      }
      // Result rows only where stage 06 or 07 acted (MQ9): c2 (a secret redacted) and c3 (external), never c1.
      expect(
        rows
          .filter((row) => row.kind === "result")
          .map((row) => row.toolCallId)
          .sort(),
      ).toEqual(["c2", "c3"]);
      expect(rows.find((row) => row.toolCallId === "c5" && row.kind === "call")).toMatchObject({
        decision: "block",
        reason: "denied: pap-test-blocked *",
      });
      expect(JSON.stringify(rows)).not.toContain(TOKEN);
    } finally {
      await t.stop();
    }
  }, 90_000);
});
