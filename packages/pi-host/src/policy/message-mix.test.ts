import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PolicyRules } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { createMessageMix, type MessageMix, MIXED_MESSAGE } from "./message-mix.ts";
import type { CallFacts } from "./pipeline.ts";
import { classifyTool, SANDBOX_SOURCE, type ToolKind } from "./tool-kind.ts";

const TASK = "0a1b2c3d-0000-4000-8000-0123456789ab";
let bed: Awaited<ReturnType<typeof createPipelineBed>>;
let atlas: string;
let scratch: string;

beforeEach(async () => {
  bed = await createPipelineBed();
  atlas = join(bed.papHome, "agents", "atlas-1a2b");
  scratch = join(bed.papHome, "agents", ".runs", "atlas-1a2b", TASK);
  for (const dir of [atlas, scratch]) await mkdir(dir, { recursive: true });
  await writeFile(join(atlas, "a.txt"), "x");
});
afterEach(() => bed.dispose());

const rulesOf = (profile: "agent-thread" | "isolated-task" | "interactive" | "project") =>
  PolicyRules.parse({
    profile,
    approvalMode: "auto-accept-edits",
    ...(profile === "agent-thread" || profile === "project" ? { agentHome: atlas } : {}),
    ...(profile === "isolated-task" ? { agentHome: atlas, agentScratch: scratch } : {}),
    sandbox: { required: true, network: false },
  });
const sandboxedBash: ToolKind = {
  category: "exec",
  external: false,
  urlBearing: true,
  mcp: false,
  builtin: false,
  sandboxed: true,
};
function call(toolName: string, kind: ToolKind, rules: PolicyRules, input: unknown): CallFacts {
  return {
    event: { toolCallId: toolName, toolName, input },
    kind,
    rules,
    cwd: atlas,
    tainted: false,
    key: "k",
    exec: false,
  };
}
const shell = (rules: PolicyRules) => call("bash", sandboxedBash, rules, { command: "ln -s /x y" });
const piTool = (name: string, rules: PolicyRules, input: unknown = { path: "a.txt" }) =>
  call(name, classifyTool(name, { path: `builtin:${name}` }), rules, input);

describe.each(["agent-thread", "isolated-task", "project"] as const)(
  "one message, a sandboxed shell and a file tool (W5-R11): %s",
  (profile) => {
    const rules = rulesOf(profile);
    const refuses = (mix: MessageMix, c: CallFacts) => mix.refusal(c);

    it.each(["read", "write", "edit", "ls", "grep", "find"])(
      "refuses Pi's %s after an allowed shell",
      (tool) => {
        const mix = createMessageMix();
        mix.allowed(shell(rules));
        expect(refuses(mix, piTool(tool, rules))).toMatchObject({ outcome: "block", reason: MIXED_MESSAGE });
      },
    );

    it.each(["read", "write", "edit"])(
      "refuses the shell after an allowed Pi %s (the other order)",
      (tool) => {
        const mix = createMessageMix();
        mix.allowed(piTool(tool, rules));
        expect(refuses(mix, shell(rules))).toMatchObject({ outcome: "block", reason: MIXED_MESSAGE });
      },
    );

    it("refuses an extension tool that names a path", () => {
      const mix = createMessageMix();
      const ext = call("open_it", classifyTool("open_it", { path: "/ext/x.js" }), rules, { path: "a" });
      mix.allowed(shell(rules));
      expect(refuses(mix, ext)?.outcome).toBe("block");
    });

    it("lets a message with only the shell, or only file tools, through", () => {
      const only = createMessageMix();
      only.allowed(shell(rules));
      expect(refuses(only, shell(rules))).toBeNull();
      const files = createMessageMix();
      files.allowed(piTool("read", rules));
      expect(refuses(files, piTool("write", rules))).toBeNull();
    });

    it("starts again with the next message", () => {
      const mix = createMessageMix();
      mix.allowed(shell(rules));
      mix.reset();
      expect(refuses(mix, piTool("write", rules))).toBeNull();
    });

    it("does not count a call that was never allowed", () => {
      expect(refuses(createMessageMix(), piTool("write", rules))).toBeNull();
    });
  },
);

describe("the interactive profile is not concerned", () => {
  it("lets both through", () => {
    const rules = rulesOf("interactive");
    const mix = createMessageMix();
    mix.allowed(shell(rules));
    expect(mix.refusal(piTool("write", rules))).toBeNull();
  });
});

describe("in the pipeline", () => {
  const harness = (mix: MessageMix) =>
    bed.harness({ cwd: atlas, rules: () => rulesOf("agent-thread"), messageMix: mix });

  it("blocks a file tool after an allowed shell, with no question and the fixed reason, then lets it run in the next message", async () => {
    const mix = createMessageMix();
    mix.allowed(shell(rulesOf("agent-thread")));
    const h = harness(mix);
    const refused = await h.run("write", { path: "x.md", content: "x" });
    expect(refused).toMatchObject({ block: true });
    expect(String((refused as { reason: string }).reason)).toContain(MIXED_MESSAGE);
    expect(h.asks).toHaveLength(0);
    expect(h.entries[0]).toMatchObject({ decision: "block", reason: MIXED_MESSAGE });
    mix.reset();
    expect(await h.run("write", { path: "x.md", content: "x" }, "c2")).toBeUndefined();
  });

  it("marks an allowed file tool, so the shell that follows is refused", async () => {
    const mix = createMessageMix();
    const h = harness(mix);
    expect(await h.run("read", { path: "a.txt" })).toBeUndefined();
    expect(mix.refusal(shell(rulesOf("agent-thread")))?.outcome).toBe("block");
  });

  it("does not mark a file tool the owner denied", async () => {
    const mix = createMessageMix();
    const h = bed.harness({
      cwd: atlas,
      rules: () => rulesOf("agent-thread"),
      messageMix: mix,
      answers: [{ answer: "deny", closed: false }],
    });
    await h.run("write", { path: join(bed.outside, "x.md"), content: "x" });
    expect(mix.refusal(shell(rulesOf("agent-thread")))).toBeNull();
  });
});

describe("after the join: the registered sandboxed shell, not a hand-built kind", () => {
  const sandboxFacts = { path: SANDBOX_SOURCE, sandboxNetwork: false };

  it("classifies as sandboxed and not builtin, so the mix keys on it", () => {
    expect(classifyTool("bash", sandboxFacts)).toMatchObject({ builtin: false, sandboxed: true });
  });

  it("refuses a Pi path tool in the same message as an allowed sandboxed shell, with no question", async () => {
    const mix = createMessageMix();
    const h = bed.harness({
      cwd: atlas,
      rules: () => rulesOf("agent-thread"),
      messageMix: mix,
      tools: { bash: sandboxFacts },
    });
    expect(await h.run("bash", { command: "ls" }, "c1")).toBeUndefined();
    const refused = await h.run("write", { path: "x.md", content: "x" }, "c2");
    expect(refused).toMatchObject({ block: true });
    expect(h.asks).toHaveLength(0);
    expect(h.entries.at(-1)).toMatchObject({ decision: "block", reason: MIXED_MESSAGE });
  });
});
