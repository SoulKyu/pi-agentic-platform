import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PolicyRules } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import type { CallFacts, PipelineDeps } from "./pipeline.ts";
import { approvalStage } from "./stage-approval.ts";
import type { ToolKind } from "./tool-kind.ts";
import { markAskable } from "./unchecked.ts";

const TASK = "0a1b2c3d-0000-4000-8000-0123456789ab";
let bed: Awaited<ReturnType<typeof createPipelineBed>>;
let atlas: string;
let scout: string;
let scratch: string;

beforeEach(async () => {
  bed = await createPipelineBed();
  vi.stubEnv("HOME", join(bed.base, "home"));
  await mkdir(join(bed.base, "home"), { recursive: true });
  const agents = join(bed.papHome, "agents");
  atlas = join(agents, "atlas-1a2b");
  scout = join(agents, "scout-0000");
  scratch = join(agents, ".runs", "atlas-1a2b", TASK);
  for (const dir of [atlas, scout, scratch]) await mkdir(dir, { recursive: true });
  await writeFile(join(atlas, "a.txt"), "home notes");
  await writeFile(join(atlas, "MEMORY.md"), "x");
  await writeFile(join(scout, "MEMORY.md"), "x");
  await writeFile(join(bed.outside, "secret.txt"), "x");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await bed.dispose();
});

const thread = (over: Record<string, unknown> = {}) =>
  PolicyRules.parse({
    profile: "agent-thread",
    approvalMode: "auto-accept-edits",
    agentHome: atlas,
    sandbox: { required: true, network: false },
    ...over,
  });
const isolated = (over: Record<string, unknown> = {}) =>
  PolicyRules.parse({
    profile: "isolated-task",
    approvalMode: "auto-accept-edits",
    agentHome: atlas,
    agentScratch: scratch,
    sandbox: { required: true, network: false },
    ...over,
  });

const sandboxedBash: ToolKind = {
  category: "exec",
  external: false,
  urlBearing: true,
  mcp: false,
  builtin: false,
  sandboxed: true,
};
function sandboxedCall(rules: PolicyRules, cwd: string, tainted = false): CallFacts {
  return {
    event: { toolCallId: "c1", toolName: "bash", input: { command: "echo hi > note.md" } },
    kind: sandboxedBash,
    rules,
    cwd,
    tainted,
    key: "k",
    exec: false,
  };
}
const stage = (call: CallFacts) =>
  approvalStage(call, { hasUI: true, cwd: call.cwd }, {
    ...bed.deps,
    sessionId: () => undefined,
  } as unknown as PipelineDeps);

const run = (
  rules: PolicyRules,
  name: string,
  input: unknown,
  options: Parameters<typeof bed.harness>[0] = {},
) => {
  const h = bed.harness({ cwd: scratch, rules: () => rules, ...options });
  return h.run(name, input).then((result) => ({ result, h }));
};

describe("stage 03 in an agent thread (M11R30, M11R31)", () => {
  it("allows pap's sandboxed shell without network as an edit of the home, whatever the taint", async () => {
    const plan = await stage(sandboxedCall(thread(), atlas));
    expect(plan).toEqual({ outcome: "allow", reason: "sandboxed shell, its own folder only" });
    expect((await stage(sandboxedCall(thread(), atlas, true))).outcome).toBe("allow");
  });

  it("asks for the sandboxed shell in supervised and blocks it in read-only", async () => {
    expect((await stage(sandboxedCall(thread({ approvalMode: "supervised" }), atlas))).outcome).toBe("ask");
    expect((await stage(sandboxedCall(thread({ approvalMode: "read-only" }), atlas))).outcome).toBe("block");
  });

  it("asks for a shell with network, and Deny / Allow once only when tainted", async () => {
    const network = thread({ sandbox: { required: true, network: true } });
    expect(await stage(sandboxedCall(network, atlas))).toMatchObject({
      outcome: "ask",
      answers: ["deny", "session", "always", "once"],
    });
    expect(await stage(sandboxedCall(network, atlas, true))).toMatchObject({
      outcome: "ask",
      answers: ["deny", "once"],
      grantable: false,
    });
  });

  it("treats a shell as network-on when the rules carry no sandbox at all", async () => {
    const call = sandboxedCall(thread({ sandbox: null }), atlas, true);
    expect(await stage(call)).toMatchObject({ outcome: "ask", answers: ["deny", "once"] });
  });

  it("keeps the matrix for Pi's own tools: an edit of MEMORY.md in the home runs unasked", async () => {
    const h = bed.harness({ cwd: atlas, rules: () => thread() });
    expect(await h.run("edit", { path: "MEMORY.md" })).toBeUndefined();
    expect(h.asks).toHaveLength(0);
    expect(h.entries[0]).toMatchObject({ category: "edit", decision: "allow" });
  });

  it("asks for another agent's notes and for a plain session's edit of the same file", async () => {
    const h = bed.harness({ cwd: atlas, rules: () => thread() });
    await h.run("edit", { path: join(scout, "MEMORY.md") });
    expect(h.asks).toHaveLength(1);
    const plain = bed.harness({
      cwd: atlas,
      rules: () => PolicyRules.parse({ profile: "interactive", approvalMode: "auto-accept-edits" }),
    });
    await plain.run("edit", { path: "MEMORY.md" });
    expect(plain.asks).toHaveLength(1);
    expect(plain.asks[0]?.message).toContain("(protected path)");
  });

  it("blocks a read of another agent's notes and not of its own (W5-R63)", async () => {
    const h = bed.harness({ cwd: atlas, rules: () => thread() });
    expect(await h.run("read", { path: "a.txt" })).toBeUndefined();
    expect(await h.run("read", { path: join(scout, "MEMORY.md") }, "c2")).toMatchObject({ block: true });
    expect(h.asks).toHaveLength(0);
  });
});

describe("a shell whose writable folder the rules do not name (M3)", () => {
  it("blocks the thread's sandboxed shell without an agent home, or with one that is no agent folder", async () => {
    for (const agentHome of [null, bed.papHome, `${atlas}/../scout-0000`])
      expect((await stage(sandboxedCall(thread({ agentHome }), atlas))).outcome).toBe("block");
  });

  it("blocks the isolated task's sandboxed shell without a scratch folder, or with one that is no scratch folder", async () => {
    for (const agentScratch of [null, atlas, bed.papHome])
      expect((await stage(sandboxedCall(isolated({ agentScratch }), scratch))).outcome).toBe("block");
  });
});

describe("a pap home whose own path holds a .runs folder (M3)", () => {
  it("still tells a home from a scratch folder", async () => {
    const papHome = join(bed.base, ".runs", "pap");
    const home = join(papHome, "agents", "atlas-1a2b");
    const task = join(papHome, "agents", ".runs", "atlas-1a2b", TASK);
    for (const dir of [home, task]) await mkdir(dir, { recursive: true });
    const deps = { ...bed.deps, papHome, sessionId: () => undefined } as unknown as PipelineDeps;
    const plan = (rules: PolicyRules, cwd: string) =>
      approvalStage(sandboxedCall(rules, cwd), { hasUI: true, cwd }, deps);
    expect((await plan(thread({ agentHome: home }), home)).outcome).toBe("allow");
    expect((await plan(thread({ agentHome: task }), task)).outcome).toBe("block");
    expect((await plan(isolated({ agentHome: home, agentScratch: task }), task)).outcome).toBe("allow");
    expect((await plan(isolated({ agentHome: home, agentScratch: home }), home)).outcome).toBe("block");
  });
});

describe("a third spelling of pap's home (another symbolic link to it)", () => {
  it("judges a scratch folder from its real path, so the isolated task is still allowed", async () => {
    const third = join(bed.base, "third-spelling");
    await symlink(bed.papHome, third, "dir");
    const viaThird = (...parts: string[]) => join(third, "agents", ...parts);
    const rules = isolated({
      agentHome: viaThird("atlas-1a2b"),
      agentScratch: viaThird(".runs", "atlas-1a2b", TASK),
    });
    expect((await stage(sandboxedCall(rules, scratch))).outcome).toBe("allow");
    // A home named through the third spelling is still no scratch folder.
    const wrong = isolated({ agentScratch: viaThird("atlas-1a2b") });
    expect((await stage(sandboxedCall(wrong, scratch))).outcome).toBe("block");
  });
});

describe("the roots of an isolated task's reads are agent folders in fact (M2)", () => {
  it("fails closed when the rules name a home that is no agent home", async () => {
    await writeFile(join(bed.papHome, "state.db"), "x");
    const rules = isolated({ agentHome: bed.papHome });
    const { result } = await run(rules, "read", { path: join(bed.papHome, "state.db") });
    expect(result).toMatchObject({ block: true });
    await writeFile(join(scratch, "out.txt"), "x");
    expect((await run(rules, "read", { path: "out.txt" })).result).toMatchObject({ block: true });
  });

  it("fails closed when the scratch folder is no scratch folder", async () => {
    await writeFile(join(bed.papHome, "state.db"), "x");
    const rules = isolated({ agentScratch: bed.papHome });
    const { result } = await run(rules, "read", { path: "state.db" }, { cwd: bed.papHome });
    expect(result).toMatchObject({ block: true });
  });
});

describe("lever B, the unreadable command (decision 71, M11R31)", () => {
  it("is asked only for the profiles that are attended: an allowlist, not 'anything but isolated'", () => {
    const facts = (profile: string) =>
      ({ rules: { profile, approvalMode: "auto-accept-edits", unattended: false } }) as unknown as CallFacts;
    const ctx = { hasUI: true, cwd: "/" };
    expect(markAskable(ctx, facts("interactive"))).toBe(true);
    expect(markAskable(ctx, facts("agent-thread"))).toBe(true);
    expect(markAskable(ctx, facts("isolated-task"))).toBe(false);
    expect(markAskable(ctx, facts("future-profile"))).toBe(false);
  });

  const UNREADABLE = "true;".repeat(1001);

  it("asks Deny / Allow once in an agent thread, which is attended", async () => {
    const h = bed.harness({ cwd: atlas, rules: () => thread({ sandbox: null }) });
    expect(await h.run("bash", { command: UNREADABLE })).toBeUndefined();
    expect(h.asks.map((ask) => ask.answers)).toEqual([["deny", "once"]]);
  });

  it("stays withheld in an isolated task: blocked at stage 01, no question", async () => {
    const h = bed.harness({ cwd: scratch, rules: () => isolated({ sandbox: null, unattended: true }) });
    expect(await h.run("bash", { command: UNREADABLE })).toMatchObject({ block: true });
    expect(h.asks).toEqual([]);
  });
});

describe("stage 03 in an isolated task (M11R32)", () => {
  it("lets a read of the home and of the scratch folder run, and a listing of the cwd", async () => {
    await writeFile(join(scratch, "out.txt"), "x");
    for (const [tool, input] of [
      ["read", { path: join(atlas, "a.txt") }],
      ["read", { path: "out.txt" }],
      ["ls", {}],
      ["grep", { pattern: "x" }],
    ] as const) {
      const { result, h } = await run(isolated(), tool, input);
      expect(result).toBeUndefined();
      expect(h.asks).toHaveLength(0);
    }
  });

  it("blocks a read outside, a missing file and a tilde path", async () => {
    for (const path of [
      join(bed.outside, "secret.txt"),
      join(scratch, "missing.txt"),
      "~/x",
      join(scout, "MEMORY.md"),
    ]) {
      const { result, h } = await run(isolated(), "read", { path });
      expect(result).toMatchObject({ block: true });
      expect(h.asks).toHaveLength(0);
    }
  });

  it("writes the scratch folder unasked and never the home", async () => {
    expect((await run(isolated(), "write", { path: "out.txt", content: "x" })).result).toBeUndefined();
    const home = await run(isolated(), "write", { path: join(atlas, "MEMORY.md"), content: "x" });
    expect(home.result).toMatchObject({ block: true });
    expect(home.h.asks).toHaveLength(0);
    expect(home.h.entries[0]).toMatchObject({ decision: "block" });
  });

  it("blocks a protected name in the scratch folder and any write from a folder that is not the scratch folder", async () => {
    expect((await run(isolated(), "write", { path: ".git/config", content: "x" })).result).toMatchObject({
      block: true,
    });
    const elsewhere = await run(
      isolated(),
      "write",
      { path: join(bed.cwd, "x.txt"), content: "x" },
      { cwd: bed.cwd },
    );
    expect(elsewhere.result).toMatchObject({ block: true });
    const inHome = await run(isolated(), "write", { path: "x.md", content: "x" }, { cwd: atlas });
    expect(inHome.result).toMatchObject({ block: true });
  });

  it("asks for an edit in supervised mode, Deny / Allow once, never a grant", async () => {
    const { h } = await run(isolated({ approvalMode: "supervised" }), "write", {
      path: "out.txt",
      content: "x",
    });
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]?.answers).toEqual(["deny", "once"]);
  });

  it("blocks Pi's bash even when the rules do not require the sandbox", async () => {
    const { result } = await run(isolated({ sandbox: null }), "bash", { command: "ls" });
    expect(result).toMatchObject({ block: true });
  });

  it("blocks a URL tool without a host list, runs a listed one, asks when tainted", async () => {
    const input = { url: "https://example.com/x" };
    expect((await run(isolated(), "web_fetch", input)).result).toMatchObject({ block: true });
    const listed = isolated({ allowHosts: ["example.com"] });
    expect((await run(listed, "web_fetch", input)).result).toBeUndefined();
    const tainted = await run(listed, "web_fetch", input, { taint: true });
    expect(tainted.h.asks).toHaveLength(1);
    expect(tainted.h.asks[0]?.answers).toEqual(["deny", "once"]);
  });

  it("asks for an MCP write and blocks an unknown tool", async () => {
    const tools = { mcp__srv__write: { path: "builtin:mcp" }, odd: { path: "/ext/odd.js" } };
    const write = await run(isolated(), "mcp__srv__write", { text: "x" }, { tools });
    expect(write.h.asks).toHaveLength(1);
    expect(write.h.asks[0]?.answers).toEqual(["deny", "once"]);
    const odd = await run(isolated(), "odd", {}, { tools });
    expect(odd.result).toMatchObject({ block: true });
    expect(odd.h.asks).toHaveLength(0);
  });

  it("allows the sandboxed shell without network, blocks it with network and no list, asks with a list", async () => {
    expect((await stage(sandboxedCall(isolated(), scratch, true))).outcome).toBe("allow");
    const network = { sandbox: { required: true, network: true } };
    expect((await stage(sandboxedCall(isolated(network), scratch))).outcome).toBe("block");
    expect(
      await stage(sandboxedCall(isolated({ ...network, allowHosts: ["example.com"] }), scratch)),
    ).toMatchObject({
      outcome: "ask",
      answers: ["deny", "once"],
      grantable: false,
    });
  });

  it("blocks a mode it should never get (full access) and reads in read-only mode", async () => {
    await writeFile(join(scratch, "out.txt"), "x");
    const full = await run(isolated({ approvalMode: "full-access" }), "read", { path: "out.txt" });
    expect(full.result).toMatchObject({ block: true });
    expect(
      (await run(isolated({ approvalMode: "read-only" }), "read", { path: "out.txt" })).result,
    ).toBeUndefined();
    expect(
      (await run(isolated({ approvalMode: "read-only" }), "write", { path: "o.txt", content: "x" })).result,
    ).toMatchObject({
      block: true,
    });
  });
});
