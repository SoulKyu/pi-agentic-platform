import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALLOW_03, createPipelineBed, interactiveRules } from "../testing/pipeline-bed.ts";
import { MCP_SOURCE } from "./tool-kind.ts";
import {
  NOT_ALLOWLISTED,
  NOT_ALLOWLISTED_MODEL_REASON,
  UNATTENDED_UNKNOWN,
  UNATTENDED_UNKNOWN_MODEL_REASON,
} from "./tool-allowlist.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

const LIST = ["read", "codemode", "myext_tool"];
const rules =
  (extra: object = {}) =>
  () => ({ ...interactiveRules, toolAllowlist: LIST, ...extra });
const NOT_LISTED = { block: true, reason: NOT_ALLOWLISTED_MODEL_REASON };
const UNKNOWN = { block: true, reason: UNATTENDED_UNKNOWN_MODEL_REASON };
const tools = {
  myext_tool: { path: "/ext/my.js" },
  read: { path: "/ext/read.js" },
  mcp__fix__lookup: { path: MCP_SOURCE, readOnlyHint: true },
};

describe("stage 02: the automation's tool allowlist (M10R27)", () => {
  it("blocks a nested codemode call by its own name, before the preset check", async () => {
    const h = bed.harness({
      rules: rules({ presetTools: ["read"] }),
      stages: ALLOW_03,
    });
    expect(await h.run("bash", { command: "echo hi" }, "n1", "parent-codemode")).toEqual(NOT_LISTED);
    expect(h.entries.at(-1)).toMatchObject({ decision: "block", reason: NOT_ALLOWLISTED });
    expect(h.entries.at(-1)?.stages[1]).toMatchObject({ stage: "02", outcome: "block" });
  });

  it("blocks an MCP tool tool_search loaded when it is not listed", async () => {
    const h = bed.harness({ rules: rules(), tools, stages: ALLOW_03 });
    expect(await h.run("mcp__fix__lookup", { q: 1 })).toEqual(NOT_LISTED);
  });

  it("blocks an extension tool of unknown kind while unattended, and asks per the matrix otherwise", async () => {
    const attended = bed.harness({
      rules: rules(),
      tools,
      stages: {
        approval: async () => ({
          outcome: "ask",
          reason: "asks",
          answers: ["deny", "once"],
          grantable: false,
        }),
      },
    });
    expect(await attended.run("myext_tool", {})).toBeUndefined();
    expect(attended.asks).toHaveLength(1);

    const h = bed.harness({ rules: rules({ unattended: true }), tools, stages: ALLOW_03 });
    expect(await h.run("myext_tool", {})).toEqual(UNKNOWN);
    expect(h.entries.at(-1)).toMatchObject({ decision: "block", reason: UNATTENDED_UNKNOWN });
    expect(h.entries.at(-1)?.stages[1]).toMatchObject({ stage: "02", outcome: "block" });
  });

  it("blocks an extension that took a built-in's name when unattended (not builtin:read)", async () => {
    const h = bed.harness({ rules: rules({ unattended: true }), tools, stages: ALLOW_03 });
    expect(await h.run("read", { path: "a" })).toEqual(UNKNOWN);
  });

  it("lets the listed built-in read pass on to the other checks", async () => {
    const h = bed.harness({ rules: rules({ unattended: true }), stages: ALLOW_03 });
    expect(await h.run("read", { path: "a" })).toBeUndefined();
    expect(h.entries.at(-1)).toMatchObject({ decision: "allow" });
  });
});
