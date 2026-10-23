import { AutomationSettings } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { createDryRun } from "./dry-run.ts";
import { createPrecheckStep } from "./precheck-step.ts";
import { AGENT, fakeAgentPorts, insertAgentTrigger } from "./testing/agent-fakes.ts";
import { type AutomationBed, createAutomationBed } from "./testing/bed.ts";
import { createAgentBinding } from "./trigger-agent.ts";

let bed: AutomationBed;
beforeAll(() => {
  bed = createAutomationBed();
});
afterAll(() => bed.dispose());

const how = { source: "manual", gated: false, origin: "manual" } as const;

function setup() {
  const binding = createAgentBinding();
  const fakes = fakeAgentPorts("/pap-fake-root");
  fakes.add(AGENT, "u1", { paused: false, quarantinedAt: null });
  binding.bind(fakes.ports);
  const id = insertAgentTrigger(bed.db, fakes.homeOf(AGENT), {
    id: `trg-${Math.random().toString(16).slice(2)}`,
    precheck: "true",
  });
  const record = bed.triggers.get("u1", id);
  if (!record) throw new Error("trigger not saved");
  const run = vi.fn(async () => ({ verdict: "pass" as const, exitCode: 0, durationMs: 1, output: "ok" }));
  const settings = { automation: () => AutomationSettings.parse({}) };
  const step = createPrecheckStep({
    db: bed.db,
    clock: bed.clock,
    logger: bed.logger,
    settings,
    gates: { over: () => false },
    triggers: bed.triggers,
    precheck: { run },
    agents: binding,
  });
  const dry = createDryRun({
    clock: bed.clock,
    logger: bed.logger,
    triggers: bed.triggers,
    store: { queuedOfTrigger: () => 0 },
    gates: { over: () => false, spentToday: () => 0 },
    settings,
    precheck: { run },
    agents: binding,
  });
  return { step, dry, record, run, fakes, id };
}

describe("a stored precheck on an agent trigger (agents run in microVMs)", () => {
  it("refuses a stored precheck on an agent trigger", async () => {
    const { step, record, run, fakes, id } = setup();
    expect(await step.run(record, how)).toMatchObject({
      kind: "stop",
      verdict: "error",
      detail: "precheck_agent",
      answer: "precheck_agent",
    });
    expect(bed.db.all("SELECT verdict, detail FROM trigger_fires WHERE trigger_id = $id", { id })).toEqual([
      { verdict: "error", detail: "precheck_agent" },
    ]);
    expect(run).not.toHaveBeenCalled();
    expect(fakes.createAgentSession).not.toHaveBeenCalled();
  });

  it("the dry run says the same word and runs nothing", async () => {
    const { dry, run, id } = setup();
    const result = await dry.run(testCaller(), { triggerId: id });
    expect(result.precheck).toMatchObject({ verdict: "error", output: "precheck_agent" });
    expect(run).not.toHaveBeenCalled();
  });
});
