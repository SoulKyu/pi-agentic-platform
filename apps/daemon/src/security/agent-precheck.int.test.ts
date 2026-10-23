import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput, TriggerInput } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "../testing/harness.ts";
import { callOf, spawnCounting, spawnsOf, taskRowsOf } from "./testing/agent-bed.ts";
import { createTrigger, openOwner, type Owner, rows } from "./testing/automation-bed.ts";

// Agents run in microVMs: a precheck stored on an agent trigger is refused at fire time (`precheck_agent`), never ignored
// (it would wake the agent, and spend tokens, at every tick) and never run on the host.
let t: TestDaemon;
let owner: Owner;
let scratch: string;
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "pap-agent-precheck-"));
  t = await startTestDaemon(
    { steps: [{ text: "x" }] },
    { vm: true, ...spawnCounting(join(scratch, "spawns.log")) },
  );
  owner = await openOwner(t);
});
afterAll(async () => {
  owner?.client.close();
  await t?.stop();
  rmSync(scratch, { recursive: true, force: true });
});

describe("a stored precheck on an agent trigger", () => {
  it("is refused at fire time: no precheck process, no worker, no task", async () => {
    const call = callOf(owner.client);
    const agent = await call<{ id: string }>("agents.create", {
      input: AgentInput.parse({ name: "Atlas", preset: "read-only" }),
    });
    const trigger = await createTrigger(
      owner.client,
      TriggerInput.parse({
        name: "Atlas manual",
        enabled: true,
        source: { type: "manual" },
        execution: { agent: { agentId: agent.id, target: "isolated" }, precheck: "true" },
        prompt: "go",
      }),
    );
    await owner.client.call("automation.fire", { triggerId: trigger.id });
    expect(
      rows<{ verdict: string; detail: string | null }>(
        t.home,
        "SELECT verdict, detail FROM trigger_fires WHERE trigger_id = ? ORDER BY id",
        trigger.id,
      ),
    ).toEqual([{ verdict: "error", detail: "precheck_agent" }]);
    expect(taskRowsOf(t, agent.id)).toEqual([]);
    expect(spawnsOf(join(scratch, "spawns.log"))).toBe(0);
  }, 60_000);
});
