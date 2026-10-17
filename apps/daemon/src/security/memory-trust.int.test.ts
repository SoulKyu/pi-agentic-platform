import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startTestDaemon } from "../testing/harness.ts";
import { dialogIdOf, lookupTool, markOf, nextDialog, sessionIdOf, waitIdle } from "./testing/fixtures.ts";

// M11R143, daemon half: a plain session whose run reads external content is tainted, its worker is released once the
// run settles, and the next worker starts closed. pi-mem0 itself is never loaded: a stand-in records what it would read.
const MEMORY_EXTENSION = `import { appendFileSync } from "node:fs";
const log = (line) => appendFileSync(process.env.MEM_REC, JSON.stringify(line) + "\\n");
export default function (pi) {
  pi.on("session_start", (_event, ctx) => {
    let profile = null;
    for (const e of ctx.sessionManager.getEntries())
      if (e.type === "custom" && e.customType === "pi-web:agent-profile" && e.data?.version === 1) profile = e.data;
    log({ at: "session_start", profile, capture: process.env.PI_MEM0_CAPTURE ?? null });
  });
  pi.on("agent_end", (_event, ctx) => {
    log({ at: "agent_end", custom: ctx.sessionManager.getEntries().filter((e) => e.type === "custom").map((e) => e.customType) });
  });
}
`;
const lookup = { toolCalls: [{ name: "lookup", args: { q: "x" }, id: "l1" }] };
const saw = (file: string): Array<Record<string, unknown>> =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("security: memory trust follows the taint (daemon)", () => {
  it("releases the worker once a tainted run settles, and the next worker starts closed", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "pap-memtrust-"));
    const file = join(scratch, "memory.jsonl");
    const t = await startTestDaemon(
      { steps: [lookup, { text: "one" }] },
      {
        extensions: { mem: MEMORY_EXTENSION, lookup: lookupTool("some outside words") },
        workerEnv: { MEM_REC: file },
      },
    );
    try {
      const client = await t.connect(await t.login());
      const sessionId = sessionIdOf(await client.call("sessions.create", { cwd: t.cwd }));
      await client.call("subscribe.session", { sessionId });
      let mark = markOf(client);
      await client.call("sessions.prompt", { sessionId, text: "one" });
      const card = await nextDialog(client, mark);
      await client.call("sessions.respondDialog", {
        sessionId,
        dialogId: dialogIdOf(card),
        response: { answer: "once" },
      });
      await client.waitForEvent((f) => (f.event as { status?: string }).status === "cold" && f.seq > mark);

      // The new worker replays the script from its first step: the tool asks again, and this time the owner denies.
      mark = markOf(client);
      await client.call("sessions.prompt", { sessionId, text: "two" });
      const again = await nextDialog(client, mark);
      await client.call("sessions.respondDialog", {
        sessionId,
        dialogId: dialogIdOf(again),
        response: { answer: "deny" },
      });
      await waitIdle(client, mark);

      const seen = saw(file);
      const starts = seen.filter((line) => line.at === "session_start");
      expect(starts).toHaveLength(2);
      // The first worker was an ordinary session; the tainted run left the marker for a pi-mem0 that reads it at capture.
      expect(starts[0]).toMatchObject({ profile: null, capture: null });
      expect(seen.find((line) => line.at === "agent_end")?.custom).toContain("pap:memory-trust");
      // The second one starts closed: no valid profile, and capture off in its environment.
      expect(starts[1]).toMatchObject({
        profile: { version: 1, profile: "", trust: "untrusted" },
        capture: "0",
      });
    } finally {
      await t.stop();
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120_000);

  it("keeps the worker of a session that stayed clean", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "pap-memtrust-"));
    const file = join(scratch, "memory.jsonl");
    const t = await startTestDaemon(
      { steps: [{ text: "one" }, { text: "two" }] },
      { extensions: { mem: MEMORY_EXTENSION }, workerEnv: { MEM_REC: file } },
    );
    try {
      const client = await t.connect(await t.login());
      const sessionId = sessionIdOf(await client.call("sessions.create", { cwd: t.cwd }));
      await client.call("subscribe.session", { sessionId });
      for (const text of ["one", "two"]) {
        const mark = markOf(client);
        await client.call("sessions.prompt", { sessionId, text });
        await waitIdle(client, mark);
      }
      expect(saw(file).filter((line) => line.at === "session_start")).toHaveLength(1);
    } finally {
      await t.stop();
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120_000);
});
