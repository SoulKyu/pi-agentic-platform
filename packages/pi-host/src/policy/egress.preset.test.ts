import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALLOW_03, createPipelineBed, interactiveRules } from "../testing/pipeline-bed.ts";
import { MCP_SOURCE } from "./tool-kind.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

const tools = {
  mcp__fix__write: { path: MCP_SOURCE, readOnlyHint: false },
  mcp__fix__lookup: { path: MCP_SOURCE, readOnlyHint: true },
};
const MCP_BLOCK = {
  block: true,
  reason: "pap-policy blocked this call: the session is read-only and this MCP tool may change things.",
};
const PRESET_BLOCK = {
  block: true,
  reason: "pap-policy blocked this call: the session's tool preset does not include this tool.",
};

describe("the read-only preset: MCP tools (M7R78)", () => {
  const preset = () => ({ ...interactiveRules, readOnlyPreset: true });

  it("blocks an MCP tool that may change things in auto-accept-edits, and lets a readOnlyHint one through", async () => {
    const h = bed.harness({ rules: preset, tools, stages: ALLOW_03 });
    expect(await h.run("mcp__fix__write", { q: 1 })).toEqual(MCP_BLOCK);
    expect(h.entries.at(-1)).toMatchObject({
      decision: "block",
      reason: "MCP tool that is not read-only",
    });
    expect(await h.run("mcp__fix__lookup", { q: 1 })).toBeUndefined();
  });

  it("leaves the same tool alone without the preset", async () => {
    const h = bed.harness({ rules: () => interactiveRules, tools, stages: ALLOW_03 });
    expect(await h.run("mcp__fix__write", { q: 1 })).toBeUndefined();
  });

  it("is off by default in the contract", () => {
    expect(interactiveRules.readOnlyPreset).toBe(false);
    expect(interactiveRules.presetTools).toBeNull();
  });
});

describe("a coding tool the preset leaves out is blocked whatever reached it (codemode, tool_search)", () => {
  const pinned = (names: string[]) => () => ({ ...interactiveRules, presetTools: names });

  it("blocks bash, edit and write under the read-only names, and lets read through", async () => {
    const h = bed.harness({ rules: pinned(["read", "grep", "find", "ls"]), stages: ALLOW_03 });
    expect(await h.run("bash", { command: "echo hi" })).toEqual(PRESET_BLOCK);
    expect(await h.run("edit", { path: "a", edits: [] })).toEqual(PRESET_BLOCK);
    expect(await h.run("write", { path: "a", content: "" })).toEqual(PRESET_BLOCK);
    expect(h.entries.at(-1)).toMatchObject({ decision: "block", reason: "tool not in the session's preset" });
    expect(await h.run("read", { path: "a" })).toBeUndefined();
  });

  it("blocks every coding tool under an empty list (none, chat)", async () => {
    const h = bed.harness({ rules: pinned([]), stages: ALLOW_03 });
    for (const name of ["read", "grep", "find", "ls", "bash", "edit", "write", "powershell"])
      expect(await h.run(name, {})).toEqual(PRESET_BLOCK);
  });

  it("does not touch tools that are not coding tools", async () => {
    const h = bed.harness({ rules: pinned([]), tools, stages: ALLOW_03 });
    expect(await h.run("mcp__fix__lookup", {})).toBeUndefined();
  });

  it("blocks by name even when an extension took the name over", async () => {
    const h = bed.harness({
      rules: pinned(["read"]),
      tools: { bash: { path: "/ext/bash.js" } },
      stages: ALLOW_03,
    });
    expect(await h.run("bash", { command: "ls" })).toEqual(PRESET_BLOCK);
  });

  it("leaves everything alone when the preset pins nothing (configured)", async () => {
    const h = bed.harness({ rules: () => interactiveRules, stages: ALLOW_03 });
    expect(await h.run("bash", { command: "echo hi" })).toBeUndefined();
  });
});
