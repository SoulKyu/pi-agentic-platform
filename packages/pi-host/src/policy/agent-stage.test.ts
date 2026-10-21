import { PolicyRules } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { makeVmWorld } from "../testing/vm-world.ts";
import { judgedAs } from "./agent-stage.ts";
import type { CallFacts, PipelineDeps } from "./pipeline.ts";
import { realVmRoots } from "./vm-paths.ts";
import { SANDBOX_SOURCE } from "./tool-kind.ts";

// Mutants, each killed by the case named:
//  - `factsOf` keeps `sandboxNetwork` true in a VM        -> "a networked shell in a VM is an edit of its own folder"
//  - `judgedAs` ignores the `inVm` flag in the pipeline   -> "tainted, auto-accept-edits: no question"
//  - the host judgement changes with the flag's default    -> "host mode keeps today's judgement"

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
let world: ReturnType<typeof makeVmWorld>;
let vm: NonNullable<PipelineDeps["vm"]>;
beforeEach(async () => {
  bed = await createPipelineBed();
  world = makeVmWorld();
  vm = { layout: world.layout, roots: await realVmRoots(world.layout) };
});
afterEach(async () => {
  world.cleanup();
  await bed.dispose();
});

const rules = (network: boolean) =>
  PolicyRules.parse({
    profile: "agent-thread",
    approvalMode: "auto-accept-edits",
    agentHome: world.layout.home,
    sandbox: { required: true, network },
  });

const shellCall = (network: boolean): CallFacts =>
  ({
    kind: { category: "exec", external: true, sandboxed: true, builtin: false },
    rules: rules(network),
  }) as unknown as CallFacts;

describe("judgedAs in a VM", () => {
  it("a networked shell in a VM is an edit of its own folder", () => {
    expect(judgedAs(shellCall(true), true)).toEqual({ category: "edit", external: false });
    expect(judgedAs(shellCall(false), true)).toEqual({ category: "edit", external: false });
  });

  it("host mode keeps today's judgement", () => {
    expect(judgedAs(shellCall(true))).toEqual({ category: "exec", external: true });
    expect(judgedAs(shellCall(true), false)).toEqual({ category: "exec", external: true });
    expect(judgedAs(shellCall(false))).toEqual({ category: "edit", external: false });
  });
});

// The pairs below are what production composes (AVM2-E11): the rules' `sandbox.network` is the agent's switch, and the
// worker gives the shell tool the same value as its `sandboxNetwork`.
describe("a networked shell in a VM, through the pipeline", () => {
  const tools = { bash: { path: SANDBOX_SOURCE, sandboxNetwork: true } };

  it("off: the same pair with the network off asks nothing either", async () => {
    const h = bed.harness({
      cwd: world.layout.home,
      rules: () => rules(false),
      vm,
      tools: { bash: { path: SANDBOX_SOURCE, sandboxNetwork: false } },
    });
    expect(await h.run("bash", { command: "ls" })).toBeUndefined();
    expect(h.asked).toEqual([]);
  });

  it("tainted, auto-accept-edits: no question", async () => {
    const h = bed.harness({
      cwd: world.layout.home,
      rules: () => rules(true),
      vm,
      tools,
      taint: true,
    });
    expect(await h.run("bash", { command: "curl https://api.example.com" })).toBeUndefined();
    expect(h.asked).toEqual([]);
  });
});
