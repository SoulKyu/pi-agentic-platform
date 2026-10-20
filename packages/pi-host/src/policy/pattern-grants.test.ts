import { type PolicyRules, PolicyRules as Rules } from "@pap/contracts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PipelineDeps } from "./pipeline.ts";
import { createPipelineBed, interactiveRules } from "../testing/pipeline-bed.ts";
import { handRepo, CLEAN, SAFE_SHELL } from "./cover-bed.ts";
import { patternGrant, toolRuleSource } from "./pattern-grants.ts";
import { classifyTool } from "./tool-kind.ts";
import { UNCHECKED_REASON } from "./unchecked.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
  handRepo(bed.cwd, CLEAN);
  mkdirSync(join(bed.cwd, "sub"), { recursive: true });
});
afterAll(() => bed.dispose());

const rulesWith = (extra: Partial<PolicyRules>) => () => Rules.parse({ ...interactiveRules, ...extra });
const prefixRules = rulesWith({ alwaysPrefixes: [{ prefix: ["pnpm", "test"] }] });
const toolRules = rulesWith({ alwaysTools: [{ tool: "mcp__fix__write", source: "mcp" }] });
const MCP = { mcp__fix__write: { path: "builtin:mcp" } };
const RUNS = ["pnpm test", "pnpm test -- --run src/a.test.ts", "pnpm test 2>&1", "git status && pnpm test"];
const STRETCH = [
  "pnpm test && curl https://example.com",
  "pnpm test; rm -rf dist",
  "pnpm test $(id)",
  "pnpm test `id`",
  "pnpm test > ~/.bashrc",
  "X=1 pnpm test",
  "env pnpm test",
  "pnpm testx",
  "pnpm",
  "pnpm build",
  "pnpm test | sh",
  "bash -c 'pnpm test'",
];

describe("a prefix rule", () => {
  it.each(RUNS)("runs without a question: %s", async (command) => {
    const h = bed.harness({ rules: prefixRules, shell: SAFE_SHELL });
    expect(await h.run("bash", { command })).toBeUndefined();
    expect(h.asks).toEqual([]);
    expect(h.entries.at(-1)).toMatchObject({ decision: "allow", reason: "prefix rule" });
  });

  it.each(STRETCH)("does not stretch to %s", async (command) => {
    const h = bed.harness({ rules: prefixRules, shell: SAFE_SHELL });
    await h.run("bash", { command });
    expect(h.asks).toHaveLength(1);
    expect(h.entries.at(-1)).toMatchObject({ decision: "approved", reason: "answer: once" });
  });

  it("asks about an unreadable command, with the unchecked reason", async () => {
    const h = bed.harness({ rules: prefixRules, shell: SAFE_SHELL });
    await h.run("bash", { command: `pnpm test; ${"true;".repeat(1001)}` });
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]?.title).toBe(UNCHECKED_REASON);
    expect(h.asks[0]?.answers).toEqual(["deny", "once"]);
  });

  it("asks when no shell facts are known", async () => {
    const h = bed.harness({ rules: prefixRules });
    await h.run("bash", { command: "pnpm test" });
    expect(h.asks).toHaveLength(1);
  });
});

describe("a tool rule", () => {
  it("lets the MCP tool it names run without a question, whatever the input", async () => {
    const h = bed.harness({ rules: toolRules, tools: MCP });
    expect(await h.run("mcp__fix__write", { path: "a", text: "1" })).toBeUndefined();
    expect(await h.run("mcp__fix__write", { other: true }, "c2")).toBeUndefined();
    expect(h.asks).toEqual([]);
    expect(h.entries.at(-1)).toMatchObject({ decision: "allow", reason: "tool rule" });
  });

  it("does not cover another tool of the same server", async () => {
    const h = bed.harness({ rules: toolRules, tools: { ...MCP, mcp__fix__delete: { path: "builtin:mcp" } } });
    await h.run("mcp__fix__delete", {});
    expect(h.asks).toHaveLength(1);
  });

  it("does not cover an extension tool that took the same name", async () => {
    const h = bed.harness({ rules: toolRules, tools: { mcp__fix__write: { path: "/ext/evil.ts" } } });
    await h.run("mcp__fix__write", {});
    expect(h.asks).toHaveLength(1);
  });

  it("does not cover an MCP tool under a builtin rule, nor the reverse", async () => {
    const h = bed.harness({
      rules: rulesWith({ alwaysTools: [{ tool: "mcp__fix__write", source: "builtin" }] }),
      tools: MCP,
    });
    await h.run("mcp__fix__write", {});
    expect(h.asks).toHaveLength(1);
  });

  it("never covers bash, even when a forged update carries a rule for it", async () => {
    const h = bed.harness({
      rules: rulesWith({ alwaysTools: [{ tool: "bash", source: "builtin" }] }),
      shell: SAFE_SHELL,
    });
    await h.run("bash", { command: "make deploy" });
    expect(h.asks).toHaveLength(1);
    expect(h.entries.at(-1)).not.toMatchObject({ reason: "tool rule" });
  });

  it("never covers an unknown tool", async () => {
    const h = bed.harness({
      rules: rulesWith({ alwaysTools: [{ tool: "thing", source: "builtin" }] }),
      tools: { thing: { path: "/ext/thing.ts" } },
    });
    await h.run("thing", {});
    expect(h.asks).toHaveLength(1);
  });
});

describe("a tainted session (M7R20, MC17)", () => {
  it("asks past a prefix rule and a tool rule, deny or once only", async () => {
    const prefix = bed.harness({ rules: prefixRules, shell: SAFE_SHELL, taint: true });
    await prefix.run("bash", { command: "pnpm test" });
    const tool = bed.harness({ rules: toolRules, tools: MCP, taint: true });
    await tool.run("mcp__fix__write", {});
    expect([prefix.asks, tool.asks].map((asks) => asks.map((ask) => ask.answers))).toEqual([
      [["deny", "once"]],
      [["deny", "once"]],
    ]);
  });

  it("asks for git under a git prefix rule", async () => {
    const h = bed.harness({
      rules: rulesWith({ alwaysPrefixes: [{ prefix: ["git", "status"] }] }),
      shell: SAFE_SHELL,
      taint: true,
    });
    await h.run("bash", { command: "git status" });
    expect(h.asks).toHaveLength(1);
  });
});

describe("what the card offers", () => {
  it("offers the prefix of a bash command", async () => {
    const h = bed.harness({ shell: SAFE_SHELL });
    await h.run("bash", { command: "pnpm test" });
    expect(h.asks[0]?.alwaysScopes).toEqual({ prefix: ["pnpm", "test"] });
  });

  it("offers a whole MCP tool", async () => {
    const h = bed.harness({ tools: MCP });
    await h.run("mcp__fix__write", {});
    expect(h.asks[0]?.alwaysScopes).toEqual({ tool: true, toolSource: "mcp" });
  });

  it("offers nothing for an unknown tool, a raw command or a question without always", async () => {
    const unknown = bed.harness({ tools: { thing: { path: "/ext/thing.ts" } } });
    await unknown.run("thing", {});
    const raw = bed.harness({ shell: SAFE_SHELL });
    await raw.run("bash", { command: "ls" });
    const tainted = bed.harness({ taint: true });
    await tainted.run("bash", { command: "pnpm test" });
    expect([unknown, raw, tainted].map((h) => h.asks[0]?.alwaysScopes)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("remembers a prefix answer for the commands it covers, and says so in the audit", async () => {
    const h = bed.harness({
      shell: SAFE_SHELL,
      answers: [{ answer: "always", scope: "prefix", closed: false }],
    });
    await h.run("bash", { command: "pnpm test" });
    expect(h.entries.at(-1)).toMatchObject({ decision: "approved", reason: "answer: always (prefix)" });
    expect(await h.run("bash", { command: "pnpm test --watch" }, "c2")).toBeUndefined();
    expect(h.asks).toHaveLength(1);
    expect(h.entries.at(-1)).toMatchObject({ decision: "allow", reason: "prefix rule" });
    await h.run("bash", { command: "pnpm build" }, "c3");
    expect(h.asks).toHaveLength(2);
  });

  it("remembers a tool answer", async () => {
    const h = bed.harness({ tools: MCP, answers: [{ answer: "always", scope: "tool", closed: false }] });
    await h.run("mcp__fix__write", { a: 1 });
    expect(h.entries.at(-1)).toMatchObject({ reason: "answer: always (tool)" });
    await h.run("mcp__fix__write", { b: 2 }, "c2");
    expect(h.asks).toHaveLength(1);
    expect(h.entries.at(-1)).toMatchObject({ reason: "tool rule" });
  });

  it("keeps the exact answer as it was", async () => {
    const h = bed.harness({ shell: SAFE_SHELL, answers: [{ answer: "always", closed: false }] });
    await h.run("bash", { command: "pnpm test" });
    expect(h.entries.at(-1)).toMatchObject({ reason: "answer: always" });
    await h.run("bash", { command: "pnpm test --watch" }, "c2");
    expect(h.asks).toHaveLength(2);
  });

  it("denies a scope that was not offered", async () => {
    const tool = bed.harness({ answers: [{ answer: "always", scope: "tool", closed: false }] });
    expect(await tool.run("bash", { command: "pnpm test" })).toMatchObject({ block: true });
    expect(tool.entries.at(-1)).toMatchObject({ decision: "denied", reason: "answer not offered" });
    const prefix = bed.harness({
      shell: SAFE_SHELL,
      answers: [{ answer: "always", scope: "prefix", closed: false }],
    });
    await prefix.run("bash", { command: "./deploy.sh" });
    expect(prefix.entries.at(-1)).toMatchObject({ decision: "denied", reason: "answer not offered" });
    const unknown = bed.harness({
      tools: { thing: { path: "/ext/thing.ts" } },
      answers: [{ answer: "always", scope: "tool", closed: false }],
    });
    await unknown.run("thing", {});
    expect(unknown.entries.at(-1)).toMatchObject({ decision: "denied", reason: "answer not offered" });
  });

  it("ends a provisional prefix at the next policy update", async () => {
    let version = 0;
    const h = bed.harness({
      shell: SAFE_SHELL,
      rulesVersion: () => version,
      answers: [{ answer: "always", scope: "prefix", closed: false }],
    });
    await h.run("bash", { command: "pnpm test" });
    await h.run("bash", { command: "pnpm test --watch" }, "c2");
    expect(h.asks).toHaveLength(1);
    version = 1;
    await h.run("bash", { command: "pnpm test --again" }, "c3");
    expect(h.asks).toHaveLength(2);
  });

  it("keeps at most 1000 provisional prefixes, the oldest dropped", async () => {
    const h = bed.harness({
      shell: SAFE_SHELL,
      ask: async () => ({ answer: "always", scope: "prefix", closed: false }),
    });
    // The run guard stops at 150 calls a run (stage 04): each call starts its own run.
    const run = (command: string, id: string) => {
      h.runStart();
      return h.run("bash", { command }, id);
    };
    for (let at = 0; at <= 1000; at++) await run(`tool${at} sub`, `c${at}`);
    expect(h.asks).toHaveLength(1001);
    await run("tool0 sub", "again0");
    await run("tool1000 sub", "again1000");
    expect(h.asks).toHaveLength(1002);
  });
});

describe("the dev loop: cd <folder> && <command> (decision 117)", () => {
  const always = [{ answer: "always", scope: "prefix", closed: false }] as const;

  it("offers the prefix of the command after a cd inside the session folder, and nothing for a cd outside", async () => {
    const inside = bed.harness({ shell: SAFE_SHELL });
    await inside.run("bash", { command: "cd sub && go test ./..." });
    const outside = bed.harness({ shell: SAFE_SHELL });
    await outside.run("bash", { command: "cd /tmp && go test ./..." });
    expect(inside.asks[0]?.alwaysScopes).toEqual({ prefix: ["go", "test"] });
    expect(outside.asks[0]?.alwaysScopes).toBeUndefined();
  });

  it("remembers it, and the rule runs the same loop again but not a cd elsewhere nor a tainted session", async () => {
    const h = bed.harness({ shell: SAFE_SHELL, answers: [...always] });
    await h.run("bash", { command: "cd sub && go test ./..." });
    expect(h.entries.at(-1)).toMatchObject({ reason: "answer: always (prefix)" });
    expect(await h.run("bash", { command: "cd sub && go test ./x" }, "c2")).toBeUndefined();
    expect(await h.run("bash", { command: "go test" }, "c3")).toBeUndefined();
    expect(h.asks).toHaveLength(1);
    expect(h.entries.at(-1)).toMatchObject({ decision: "allow", reason: "prefix rule" });
    await h.run("bash", { command: "cd /tmp && go test" }, "c4");
    expect(h.asks).toHaveLength(2);
  });

  it("never counts the rule while tainted", async () => {
    const h = bed.harness({
      rules: rulesWith({ alwaysPrefixes: [{ prefix: ["go", "test"] }] }),
      shell: SAFE_SHELL,
      taint: true,
    });
    await h.run("bash", { command: "cd sub && go test" });
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]?.answers).toEqual(["deny", "once"]);
  });
});

const callOf = (
  toolName: string,
  facts: { path: string; readOnlyHint?: boolean },
  tainted = false,
  input: unknown = {},
) => {
  const kind = classifyTool(toolName, facts);
  return {
    event: { toolCallId: "c", toolName, input },
    kind,
    rules: Rules.parse({
      ...interactiveRules,
      alwaysPrefixes: [{ prefix: ["git", "status"] }, { prefix: ["pnpm", "test"] }],
    }),
    cwd: bed.cwd,
    tainted,
    key: "k",
    exec: kind.category === "exec" && kind.builtin,
  };
};

describe("the engine", () => {
  it("gives a tool rule to an edit, network or external-write tool of Pi's own, and to nothing else", () => {
    expect(toolRuleSource(callOf("write", { path: "builtin:write" }))).toBe("builtin");
    expect(toolRuleSource(callOf("web_fetch", { path: "builtin:web_fetch" }))).toBe("builtin");
    expect(toolRuleSource(callOf("mcp__a__b", { path: "builtin:mcp" }))).toBe("mcp");
    expect(toolRuleSource(callOf("bash", { path: "builtin:bash" }))).toBeNull();
    expect(toolRuleSource(callOf("read", { path: "builtin:read" }))).toBeNull();
    expect(toolRuleSource(callOf("mcp__a__b", { path: "builtin:mcp", readOnlyHint: true }))).toBeNull();
    expect(toolRuleSource(callOf("thing", { path: "/ext/thing.ts" }))).toBeNull();
  });

  it("never covers git in a tainted session, even beside a prefixed segment (MC17)", async () => {
    const deps = {
      home: bed.base,
      papHome: bed.papHome,
      agentDir: bed.agentDir,
      shell: () => SAFE_SHELL,
      grants: { provisionalPrefixes: () => [], provisionalTools: () => [] },
    } as unknown as PipelineDeps;
    const ctx = { hasUI: true, cwd: bed.cwd };
    const command = { command: "git status && pnpm test" };
    expect(await patternGrant(callOf("bash", { path: "builtin:bash" }, false, command), ctx, deps)).toBe(
      "prefix rule",
    );
    expect(await patternGrant(callOf("bash", { path: "builtin:bash" }, true, command), ctx, deps)).toBeNull();
  });
});
