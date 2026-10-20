import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PolicyRules } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { makeVmWorld } from "../testing/vm-world.ts";
import { SAFE_SHELL } from "./cover-bed.ts";
import { hasOwnFolder, vmOwnFolder } from "./agent-stage.ts";
import type { CallFacts, PipelineDeps } from "./pipeline.ts";
import * as readTarget from "./read-target.ts";
import * as targetPath from "./target-path.ts";
import { SANDBOX_SOURCE, VM_FILES_SOURCE, type ToolKind } from "./tool-kind.ts";
import { vmFileRefusal } from "./vm-stage.ts";
import { realVmRoots } from "./vm-paths.ts";

// Mutants, each run for real (RT-43):
//  - S1 `approvalStage` without the VM file stage: "a write of `@/agent/.pi/x` is blocked in full-access" and the grep/find/ls cases.
//  - S2 `hasOwnFolder` not VM-aware: "hasOwnFolder is true for the layout's home, false for a host path".
//  - S3 `reviewOf` still calling checkEditTarget in a VM, or the runs/homes fence still running: the spy cases.

vi.mock("./read-target.ts", async (original) => {
  const actual = await original<typeof import("./read-target.ts")>();
  return {
    ...actual,
    readsAgentHome: vi.fn(actual.readsAgentHome),
    readsRunsFolder: vi.fn(actual.readsRunsFolder),
    checkReadTarget: vi.fn(actual.checkReadTarget),
  };
});
vi.mock("./target-path.ts", async (original) => {
  const actual = await original<typeof import("./target-path.ts")>();
  return { ...actual, checkEditTarget: vi.fn(actual.checkEditTarget) };
});

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
let world: ReturnType<typeof makeVmWorld>;
let vm: NonNullable<PipelineDeps["vm"]>;
let home: string;
beforeEach(async () => {
  vi.clearAllMocks();
  bed = await createPipelineBed();
  world = makeVmWorld();
  home = world.layout.home;
  vm = { layout: world.layout, roots: await realVmRoots(world.layout) };
  writeFileSync(join(home, "a.txt"), "a");
  symlinkSync(world.layout.pi, join(home, "dl"));
});
afterEach(async () => {
  world.cleanup();
  await bed.dispose();
});

const thread = (mode: string, over: Record<string, unknown> = {}) =>
  PolicyRules.parse({
    profile: "agent-thread",
    approvalMode: mode,
    agentHome: home,
    sandbox: { required: true, network: false },
    ...over,
  });
const FILES = { path: VM_FILES_SOURCE, vm: true } as const;
const tools = { read: FILES, write: FILES, edit: FILES, ls: FILES };
const run = (mode: string, tool: string, input: unknown, over: Record<string, unknown> = {}) => {
  const h = bed.harness({ cwd: home, rules: () => thread(mode, over), vm, tools });
  return h.run(tool, input).then((result) => ({ result, asked: h.asked, asks: h.asks, entries: h.entries }));
};

describe("the VM file stage in the pipeline", () => {
  it("blocks a write of `@/agent/.pi/x` in full-access with no question", async () => {
    const { result, asked, entries } = await run("full-access", "write", {
      path: `@${world.layout.pi}/x`,
      content: "x",
    });
    expect(result).toEqual({ block: true, reason: "pap-policy blocked this call: rewritten path." });
    expect(asked).toEqual([]);
    expect(entries.at(-1)).toMatchObject({ kind: "call", decision: "block" });
  });

  it("blocks every mode, no question: rewrites, links, outside paths, `grep`/`find`/`ls` roots included", async () => {
    const cases: Array<[string, unknown, string]> = [
      ["read", { path: "~/../proc/self/environ" }, "rewritten path"],
      ["read", { path: "/proc/self/environ" }, "outside this agent's folders"],
      ["read", { path: world.transcript }, "outside this agent's folders"],
      ["read", { path: "dl/sessions/s.jsonl" }, "outside this agent's folders"],
      ["read", { path: "nope.txt" }, "missing"],
      ["edit", { path: "dl/sessions/s.jsonl", edits: [] }, "outside this agent's folders"],
      ["write", { path: "dl", content: "x" }, "outside this agent's folders"],
      ["grep", { pattern: "x", path: world.layout.pi }, "outside this agent's folders"],
      ["grep", { pattern: "x", path: "dl" }, "outside this agent's folders"],
      ["grep", { pattern: "x", path: "a/../dl/sessions" }, "outside this agent's folders"],
      ["find", { pattern: "*", path: "a/../dl/sessions" }, "outside this agent's folders"],
      ["find", { pattern: "*", path: ".." }, "outside this agent's folders"],
      ["ls", { path: "dl" }, "outside this agent's folders"],
      ["ls", { path: `file://${world.layout.pi}` }, "rewritten path"],
      ["read", {}, "unreadable path"],
    ];
    for (const mode of ["read-only", "supervised", "auto-accept-edits", "full-access"])
      for (const [tool, input, reason] of cases) {
        const { result, asked } = await run(mode, tool, input);
        expect(result, `${mode} ${tool} ${JSON.stringify(input)}`).toEqual({
          block: true,
          reason: `pap-policy blocked this call: ${reason}.`,
        });
        expect(asked).toEqual([]);
      }
  });

  it("`grep`, `find` and `ls` default to the cwd", async () => {
    for (const tool of ["grep", "find", "ls"]) {
      const { result } = await run("auto-accept-edits", tool, { pattern: "x" });
      expect(result, tool).toBeUndefined();
    }
  });

  it("a read under home in supervised goes on to the matrix: allowed; a write there asks", async () => {
    const read = await run("supervised", "read", { path: "a.txt" });
    expect(read.result).toBeUndefined();
    expect(read.asked).toEqual([]);
    const write = await run("supervised", "write", { path: "new/dir/b.txt", content: "b" });
    expect(write.asked).toHaveLength(1);
    // No host protected root exists in the VM: the question carries no review of a path outside the folder.
    expect(write.asks[0]?.message).not.toContain("outside");
  });

  it("an edit under the agent's folders in auto-accept-edits runs with no question", async () => {
    for (const path of ["a.txt", join(world.layout.knowledge, "k.md"), join(world.layout.inbox, "i.md")]) {
      const { result, asked } = await run("auto-accept-edits", "write", { path, content: "x" });
      expect(result).toBeUndefined();
      expect(asked).toEqual([]);
    }
  });

  it("the runs and homes fence and the host target checks never run in a VM", async () => {
    await run("auto-accept-edits", "read", { path: "a.txt" });
    await run("auto-accept-edits", "ls", {});
    await run("auto-accept-edits", "write", { path: "a.txt", content: "x" });
    await run("supervised", "edit", { path: "a.txt", edits: [] });
    expect(vi.mocked(readTarget.readsAgentHome)).not.toHaveBeenCalled();
    expect(vi.mocked(readTarget.readsRunsFolder)).not.toHaveBeenCalled();
    expect(vi.mocked(readTarget.checkReadTarget)).not.toHaveBeenCalled();
    expect(vi.mocked(targetPath.checkEditTarget)).not.toHaveBeenCalled();
  });

  it("outside a VM the same names keep their host checks (the spies see the host path)", async () => {
    const h = bed.harness({ rules: () => thread("auto-accept-edits", { agentHome: bed.cwd }) });
    await h.run("write", { path: join(bed.cwd, "a.txt"), content: "x" });
    expect(vi.mocked(targetPath.checkEditTarget)).toHaveBeenCalled();
  });

  it("a file tool that is not pap's registration is not judged by the VM rule (stage 02 owns it)", async () => {
    const h = bed.harness({
      cwd: home,
      rules: () => thread("auto-accept-edits"),
      vm,
      tools: { read: { path: "/x/ext.js" } },
    });
    const result = await h.run("read", { path: "/proc/self/environ" });
    // An unknown tool is asked about like any other; the VM rule did not decide it.
    expect(result).toBeUndefined();
    expect(h.asked).toHaveLength(1);
  });
});

describe("an isolated task and the shell in a VM", () => {
  const task = (mode: string) =>
    PolicyRules.parse({
      profile: "isolated-task",
      approvalMode: mode,
      agentHome: home,
      agentScratch: home,
      sandbox: { required: true, network: false },
    });
  const shellTools = { bash: { path: SANDBOX_SOURCE, sandboxNetwork: false }, ...tools };

  it("runs pap's shell and the file tools inside the home, blocks the rest, with no question", async () => {
    const h = bed.harness({ cwd: home, rules: () => task("auto-accept-edits"), vm, tools: shellTools });
    expect(await h.run("bash", { command: "ls" })).toBeUndefined();
    expect(await h.run("read", { path: "a.txt" })).toBeUndefined();
    expect(await h.run("write", { path: "n.txt", content: "x" })).toBeUndefined();
    expect(await h.run("read", { path: "/proc/self/environ" })).toMatchObject({ block: true });
    expect(h.asked).toEqual([]);
  });

  it("an isolated task whose rules do not name the VM's home runs no shell", async () => {
    const elsewhere = PolicyRules.parse({
      profile: "isolated-task",
      approvalMode: "auto-accept-edits",
      agentHome: home,
      agentScratch: bed.papHome,
      sandbox: { required: true, network: false },
    });
    const h = bed.harness({ cwd: home, rules: () => elsewhere, vm, tools: shellTools });
    expect(await h.run("bash", { command: "ls" })).toMatchObject({ block: true });
  });

  it("AVM-E20: a covered read-only command runs unasked in supervised in a VM, as for the host sandboxed shell", async () => {
    const rules = () => thread("supervised", { readOnlyCommands: true });
    const h = bed.harness({ cwd: home, rules, vm, tools: shellTools, shell: SAFE_SHELL });
    expect(await h.run("bash", { command: "cat a.txt" })).toBeUndefined();
    expect(h.asked).toEqual([]);
    // Not covered: still asked.
    const other = bed.harness({ cwd: home, rules, vm, tools: shellTools, shell: SAFE_SHELL });
    await other.run("bash", { command: "touch x" });
    expect(other.asked).toHaveLength(1);
  });

  it("pap's shell: no question in auto-accept-edits and full-access, a question in supervised (R15)", async () => {
    for (const mode of ["auto-accept-edits", "full-access"]) {
      const h = bed.harness({ cwd: home, rules: () => thread(mode), vm, tools: shellTools });
      expect(await h.run("bash", { command: "ls" })).toBeUndefined();
      expect(h.asked).toEqual([]);
    }
    const supervised = bed.harness({ cwd: home, rules: () => thread("supervised"), vm, tools: shellTools });
    await supervised.run("bash", { command: "ls" });
    expect(supervised.asked).toHaveLength(1);
  });

  it("a shell whose rules name a host folder is refused (no agent folder for the shell)", async () => {
    const h = bed.harness({
      cwd: home,
      rules: () => thread("full-access", { agentHome: bed.papHome }),
      vm,
      tools: shellTools,
    });
    expect(await h.run("bash", { command: "ls" })).toMatchObject({ block: true });
  });
});

describe("vmFileRefusal", () => {
  const call = (toolName: string, input: unknown, kind: Partial<ToolKind> = {}): CallFacts => ({
    event: { toolCallId: "c", toolName, input },
    kind: { category: "read", external: false, urlBearing: false, mcp: false, builtin: true, ...kind },
    rules: thread("auto-accept-edits"),
    cwd: home,
    tainted: false,
    key: "k",
    exec: false,
  });
  const ctx = () => ({ hasUI: true, cwd: home });

  it("returns null for a call that is not a built-in file tool, and for a pap shell", async () => {
    expect(await vmFileRefusal(call("bash", { command: "ls /proc" }), ctx(), vm)).toBeNull();
    expect(
      await vmFileRefusal(call("read", { path: "/proc/self/environ" }, { builtin: false }), ctx(), vm),
    ).toBeNull();
    expect(await vmFileRefusal(call("web_fetch", {}), ctx(), vm)).toBeNull();
  });

  it("judges `edit` and `write` as writes and the others as reads", async () => {
    mkdirSync(join(home, "sub"));
    const skill = join(world.layout.piAgentDir, "skills", "k.md");
    expect(await vmFileRefusal(call("read", { path: skill }), ctx(), vm)).toBeNull();
    for (const tool of ["write", "edit"])
      expect(await vmFileRefusal(call(tool, { path: skill }), ctx(), vm)).toMatchObject({
        outcome: "block",
        reason: "outside this agent's folders",
        modelReason: "pap-policy blocked this call: outside this agent's folders.",
      });
  });
});

describe("the VM's own folder", () => {
  const facts = (rules: PolicyRules): CallFacts => ({
    event: { toolCallId: "c", toolName: "bash", input: { command: "ls" } },
    kind: {
      category: "exec",
      external: false,
      urlBearing: true,
      mcp: false,
      builtin: false,
      sandboxed: true,
    },
    rules,
    cwd: home,
    tainted: false,
    key: "k",
    exec: true,
  });
  const ctx = () => ({ hasUI: true, cwd: home });
  const deps = (): PipelineDeps => ({ ...bed.deps, vm }) as unknown as PipelineDeps;

  it("hasOwnFolder is true for rules naming the layout's home and false for any host path", async () => {
    expect(await hasOwnFolder(facts(thread("supervised")), ctx(), deps())).toBe(true);
    expect(vmOwnFolder(thread("supervised"), vm)).toBe(true);
    for (const other of [
      bed.papHome,
      join(bed.papHome, "agents", "atlas"),
      world.layout.knowledge,
      `${home}/..`,
    ]) {
      mkdirSync(other, { recursive: true });
      expect(
        await hasOwnFolder(facts(thread("supervised", { agentHome: other })), ctx(), deps()),
        other,
      ).toBe(false);
      expect(vmOwnFolder(thread("supervised", { agentHome: other }), vm)).toBe(false);
    }
    expect(vmOwnFolder(PolicyRules.parse({ profile: "interactive", approvalMode: "supervised" }), vm)).toBe(
      false,
    );
  });

  it("an isolated task's folder is its scratch folder", async () => {
    const task = PolicyRules.parse({
      profile: "isolated-task",
      approvalMode: "auto-accept-edits",
      agentHome: home,
      agentScratch: home,
      sandbox: { required: true, network: false },
    });
    expect(vmOwnFolder(task, vm)).toBe(true);
    expect(await hasOwnFolder(facts(task), ctx(), deps())).toBe(true);
  });
});
