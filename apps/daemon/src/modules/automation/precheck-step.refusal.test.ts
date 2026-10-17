import { AutomationSettings, PapError } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { createDryRun } from "./dry-run.ts";
import { createPrecheckStep } from "./precheck-step.ts";
import { AGENT, fakeAgentPorts, insertAgentTrigger } from "./testing/agent-fakes.ts";
import { type AutomationBed, createAutomationBed, parsedInput } from "./testing/bed.ts";
import { createAgentBinding } from "./trigger-agent.ts";

// The journal names why a precheck was refused with the refusal's own closed word (T10), and a paused agent runs nothing.
let bed: AutomationBed;
beforeAll(() => {
  bed = createAutomationBed();
});
afterAll(() => bed.dispose());

const how = { source: "manual", gated: false, origin: "manual" } as const;

function setup(
  over: { target?: "isolated" | "thread"; paused?: boolean; quarantinedAt?: number | null } = {},
) {
  const binding = createAgentBinding();
  const fakes = fakeAgentPorts("/pap-fake-root");
  fakes.add(AGENT, "u1", { paused: over.paused ?? false, quarantinedAt: over.quarantinedAt ?? null });
  binding.bind(fakes.ports);
  const id = insertAgentTrigger(bed.db, fakes.homeOf(AGENT), {
    id: `trg-${Math.random().toString(16).slice(2)}`,
    precheck: "check.sh",
    ...(over.target ? { target: over.target } : {}),
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
const journal = (id: string) =>
  bed.db.all<{ verdict: string; detail: string | null }>(
    "SELECT verdict, detail FROM trigger_fires WHERE trigger_id = $id ORDER BY id",
    { id },
  );

describe("a refused agent precheck journals its own code", () => {
  it.each([
    ["agent_paused", "quarantined"],
    ["not_found", "missing"],
    ["sandbox_unavailable", "sandbox_unavailable"],
  ] as const)("%s from the sandbox gate is journaled as %s", async (code, detail) => {
    const { step, record, run, fakes, id } = setup();
    fakes.precheckSandbox.mockImplementation(async () => {
      throw new PapError(code);
    });
    expect(await step.run(record, how)).toMatchObject({
      kind: "stop",
      verdict: "error",
      detail,
      answer: detail,
    });
    expect(journal(id)).toEqual([{ verdict: "error", detail }]);
    expect(run).not.toHaveBeenCalled();
  });

  it("an error of another kind stays 'precheck spawn' and never writes its text", async () => {
    const { step, record, fakes } = setup();
    fakes.precheckSandbox.mockImplementation(async () => {
      throw new Error("secret-token-in-message");
    });
    expect(await step.run(record, how)).toMatchObject({ kind: "stop", detail: "precheck spawn" });
  });

  it("a folder that is gone is journaled as invalid_cwd", async () => {
    const { trigger: created } = bed.triggers.create(
      bed.owner(),
      parsedInput({
        name: "Plain",
        source: { type: "manual" },
        execution: { cwd: bed.folder, precheck: "check.sh" },
        prompt: "go",
      }),
    );
    const record = bed.triggers.get("u1", created.id);
    if (!record) throw new Error("trigger not saved");
    const { step } = setup();
    expect(await step.run({ ...record, cwd: `${bed.folder}/missing` }, how)).toMatchObject({
      kind: "stop",
      detail: "invalid_cwd",
    });
  });
});

describe("a paused or quarantined agent's precheck does not run", () => {
  it.each([
    ["paused", { paused: true }],
    ["quarantined", { quarantinedAt: 5 }],
  ] as const)("%s: no sandbox is built and no command is spawned", async (_name, over) => {
    const { step, record, run, fakes } = setup(over);
    expect(await step.run(record, how)).toEqual({ kind: "go", precheck: null });
    expect(run).not.toHaveBeenCalled();
    expect(fakes.precheckSandbox).not.toHaveBeenCalled();
  });
});

describe("the dry run of an agent trigger", () => {
  it("reports the sandbox refusal as its closed code, not as an empty error", async () => {
    const { dry, fakes, id, run } = setup();
    fakes.precheckSandbox.mockImplementation(async () => {
      throw new PapError("sandbox_unavailable");
    });
    const result = await dry.run(testCaller(), { triggerId: id });
    expect(result.precheck).toMatchObject({ verdict: "error", output: "sandbox_unavailable" });
    expect(result.reasons).toContain("precheck_error");
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a sample payload for a thread target and a token's dry run of it, as the fire does", async () => {
    const { dry, id } = setup({ target: "thread" });
    await expect(dry.run(testCaller(), { triggerId: id, payload: "outside text" })).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(dry.run(testCaller({ kind: "token" }), { triggerId: id })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect((await dry.run(testCaller(), { triggerId: id })).verdict).toBeDefined();
  });
});
