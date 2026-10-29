import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { interactiveRules, createPipelineBed } from "../testing/pipeline-bed.ts";
import { MCP_SOURCE, PLATFORM_SOURCE } from "./tool-kind.ts";

// Decision 143: the card of an extension tool of unknown kind carries the rule that would declare it local.
let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

const TODO = "/agent/.pi/agent/npm/node_modules/rpiv-todo/index.ts";
const run = async (tool: string, path: string, input: unknown = {}) => {
  const h = bed.harness({ rules: () => interactiveRules, tools: { [tool]: { path } } });
  await h.run(tool, input);
  return h.asks;
};

describe("the local tool rule on a card", () => {
  it("names the asked extension tool of unknown kind with its exact source", async () => {
    const asks = await run("todo", TODO, { op: "update" });
    expect(asks).toHaveLength(1);
    expect(asks[0]?.category).toBe("unknown");
    expect(asks[0]?.localTool).toEqual({ tool: "todo", source: TODO });
  });

  it("is absent for a built-in, an MCP tool and a source the rule cannot name", async () => {
    expect((await run("bash", "builtin:bash", { command: "make" }))[0]).not.toHaveProperty("localTool");
    expect((await run("mcp__srv__write", MCP_SOURCE))[0]).not.toHaveProperty("localTool");
    expect((await run("rogue", PLATFORM_SOURCE))[0]).not.toHaveProperty("localTool");
    expect((await run("todo", `/x/${"a".repeat(1100)}.ts`))[0]).not.toHaveProperty("localTool");
  });
});
