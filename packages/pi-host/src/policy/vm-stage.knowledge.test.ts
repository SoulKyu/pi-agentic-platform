import { join } from "node:path";
import { PolicyRules } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { makeVmWorld } from "../testing/vm-world.ts";
import type { PipelineDeps } from "./pipeline.ts";
import { VM_FILES_SOURCE } from "./tool-kind.ts";
import { realVmRoots } from "./vm-paths.ts";

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

const FILES = { path: VM_FILES_SOURCE, vm: true } as const;

/** What a tool call under `folder` comes to: the result and whether a question was asked. */
async function verdict(mode: string, tainted: boolean, tool: string, folder: string) {
  const rules = PolicyRules.parse({
    profile: "agent-thread",
    approvalMode: mode,
    agentHome: world.layout.home,
    sandbox: { required: true, network: false },
  });
  const h = bed.harness({
    cwd: world.layout.home,
    rules: () => rules,
    vm,
    taint: tainted,
    tools: { write: FILES, edit: FILES },
  });
  const input =
    tool === "write"
      ? { path: join(folder, "k.md"), content: "x" }
      : { path: join(folder, "k.md"), edits: [] };
  const result = await h.run(tool, input);
  return { result, asks: h.asked.length };
}

describe("an agent's knowledge folder in the approval matrix (SP5)", () => {
  it("gets the same verdict as the home for an edit, in every approval mode, tainted or not", async () => {
    for (const mode of ["read-only", "supervised", "auto-accept-edits", "full-access"])
      for (const tainted of [false, true])
        for (const tool of ["write", "edit"]) {
          const inHome = await verdict(mode, tainted, tool, world.layout.home);
          const inKnowledge = await verdict(mode, tainted, tool, world.layout.knowledge);
          expect(inKnowledge, `${mode} tainted=${tainted} ${tool}`).toEqual(inHome);
        }
  });

  it("an untainted auto-accept-edits write there runs with no question", async () => {
    expect(await verdict("auto-accept-edits", false, "write", world.layout.knowledge)).toEqual({
      result: undefined,
      asks: 0,
    });
  });
});
