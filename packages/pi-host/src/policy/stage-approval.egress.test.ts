import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PolicyRules } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLEAN, handRepo, SAFE_SHELL } from "./cover-bed.ts";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { egressStage } from "./egress.ts";
import type { CallFacts } from "./pipeline.ts";
import { approvalStage } from "./stage-approval.ts";
import { classifyTool, MCP_SOURCE, SANDBOX_SOURCE } from "./tool-kind.ts";

const SANDBOX_NET = { path: SANDBOX_SOURCE, sandboxNetwork: true } as const;
const SANDBOX_OFF = { path: SANDBOX_SOURCE, sandboxNetwork: false } as const;
const PYTHON = `python3 -c "import urllib.request; urllib.request.urlopen('https://unlisted.example')"`;
const CURL = "curl https://unlisted.example/page";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
let atlas: string;
beforeAll(async () => {
  bed = await createPipelineBed();
  atlas = join(bed.papHome, "agents", "atlas-1a2b");
  await mkdir(atlas, { recursive: true });
  handRepo(atlas, CLEAN);
  await writeFile(join(bed.outside, "note.txt"), "x");
});
afterAll(() => bed.dispose());

const rulesOf = (extra: Record<string, unknown> = {}) =>
  PolicyRules.parse({
    profile: "agent-thread",
    approvalMode: "full-access",
    agentHome: atlas,
    sandbox: { required: true, network: true },
    allowHosts: ["allowed.example"],
    autonomy: { hosts: ["allowed.example"] },
    ...extra,
  });

function callOf(
  name: string,
  input: unknown,
  facts: Parameters<typeof classifyTool>[1],
  rules: PolicyRules,
): CallFacts {
  const kind = classifyTool(name, facts);
  return {
    event: { toolCallId: "c1", toolName: name, input },
    kind,
    rules,
    cwd: atlas,
    tainted: false,
    key: "k",
    exec: kind.category === "exec" && (kind.builtin || kind.sandboxed === true),
  };
}

describe("stage 02 and pap's networked sandboxed shell (M11R231)", () => {
  it("skips its URL walk and its 'host not checkable' block: the proxy judges the hosts", () => {
    for (const command of [PYTHON, CURL, "nc unlisted.example 80", "echo $(curl -s $URL)"]) {
      const call = callOf("bash", { command }, SANDBOX_NET, rulesOf());
      expect(egressStage(call), command).toEqual({ outcome: "skip", reason: "egress proxy" });
    }
  });

  it("still walks a network-off sandboxed shell, which the proxy does not serve", () => {
    const call = callOf(
      "bash",
      { command: CURL },
      SANDBOX_OFF,
      rulesOf({ sandbox: { required: true, network: false } }),
    );
    expect(egressStage(call)).toMatchObject({
      outcome: "block",
      reason: "web host not allowed: unlisted.example",
    });
  });

  it("still blocks Pi's own bash with a list: it is no proxied shell", () => {
    const rules = rulesOf({ sandbox: null, autonomy: null });
    const call = callOf("bash", { command: CURL }, { path: "builtin:bash" }, rules);
    expect(egressStage(call)).toMatchObject({
      outcome: "block",
      reason: "web host not allowed: unlisted.example",
    });
    const reach = callOf(
      "bash",
      { command: "curl --proxy x.test http://allowed.example" },
      { path: "builtin:bash" },
      rules,
    );
    expect(egressStage(reach)).toMatchObject({ outcome: "block", reason: "host not checkable: curl" });
  });

  it("still applies the sandbox rule, the preset pin and the denylist's earlier stages before it skips", () => {
    const pinned = callOf("bash", { command: CURL }, SANDBOX_NET, rulesOf({ presetTools: ["read"] }));
    expect(egressStage(pinned)).toMatchObject({
      outcome: "block",
      reason: "tool not in the session's preset",
    });
    const unsandboxed = callOf("bash", { command: CURL }, { path: "builtin:bash" }, rulesOf());
    expect(egressStage(unsandboxed)).toMatchObject({
      outcome: "block",
      reason: "unsandboxed shell in a sandboxed agent",
    });
  });
});

describe("stage 03 and trusted autonomy over the proxy (M11R240, M11R241)", () => {
  const harness = (rules: PolicyRules, tainted = true, extra: Parameters<typeof bed.harness>[0] = {}) =>
    bed.harness({
      cwd: atlas,
      rules: () => rules,
      tools: { bash: SANDBOX_NET },
      taint: tainted,
      shell: SAFE_SHELL,
      ...extra,
    });
  const command = { command: PYTHON };
  const fetch = { command: "pnpm test" };

  it("runs the networked shell after external content in full access, with the reason trusted autonomy", async () => {
    const h = harness(rulesOf());
    expect(await h.run("bash", command)).toBeUndefined();
    expect(h.asks).toHaveLength(0);
    expect(h.entries.at(-1)).toMatchObject({
      decision: "allow",
      reason: "trusted autonomy",
      stages: expect.arrayContaining([{ stage: "03", outcome: "allow", reason: "trusted autonomy" }]),
    });
  });

  it("keeps the plain reason when autonomy changed nothing: no taint", async () => {
    const h = harness(rulesOf(), false);
    expect(await h.run("bash", command)).toBeUndefined();
    expect(h.entries.at(-1)).toMatchObject({ decision: "allow", reason: "exec allowed" });
  });

  it.each(["auto-accept-edits", "supervised"] as const)(
    "asks the mode's own exec question in %s after taint, not the once-only taint card",
    async (approvalMode) => {
      const h = harness(rulesOf({ approvalMode }));
      await h.run("bash", command);
      expect(h.asks).toHaveLength(1);
      expect(h.asks[0]?.answers).toEqual(["deny", "session", "always", "once"]);
      expect(h.entries.at(-1)).toMatchObject({ decision: "approved" });
    },
  );

  it("lets the owner's earlier answer work after taint", async () => {
    const h = harness(rulesOf({ approvalMode: "auto-accept-edits" }), true, {
      answers: [{ answer: "session", closed: false }],
    });
    await h.run("bash", command);
    expect(h.asks).toHaveLength(1);
    expect(await h.run("bash", command, "c2")).toBeUndefined();
    expect(h.asks).toHaveLength(1);
    expect(h.entries.at(-1)).toMatchObject({ decision: "allow", reason: "session rule" });
  });

  it("without autonomy, still asks Deny / Allow once after taint, in every mode", async () => {
    for (const approvalMode of ["full-access", "auto-accept-edits", "supervised"] as const) {
      const h = harness(rulesOf({ approvalMode, autonomy: null }));
      await h.run("bash", command);
      expect(h.asks, approvalMode).toHaveLength(1);
      expect(h.asks[0]?.answers, approvalMode).toEqual(["deny", "once"]);
    }
  });

  it("gives an agent without a host list of its own nothing: autonomy with no hosts still asks Deny / Allow once", async () => {
    for (const approvalMode of ["full-access", "auto-accept-edits"] as const) {
      const h = harness(rulesOf({ approvalMode, autonomy: { hosts: [] }, allowHosts: null }));
      await h.run("bash", command);
      expect(h.asks, approvalMode).toHaveLength(1);
      expect(h.asks[0]?.answers, approvalMode).toEqual(["deny", "once"]);
    }
  });

  it("applies a prefix rule given earlier after taint, and offers the prefix scope on the covered card", async () => {
    const rules = rulesOf({
      approvalMode: "auto-accept-edits",
      alwaysPrefixes: [{ prefix: ["pnpm", "test"] }],
    });
    const h = harness(rules);
    expect(await h.run("bash", fetch)).toBeUndefined();
    expect(h.asks).toHaveLength(0);
    expect(h.entries.at(-1)).toMatchObject({ decision: "allow", reason: "prefix rule" });
    const ask = harness(rulesOf({ approvalMode: "auto-accept-edits" }));
    await ask.run("bash", fetch);
    expect(ask.asks[0]?.alwaysScopes?.prefix).toBeDefined();
  });

  it("does not apply the prefix rule after taint when autonomy is off", async () => {
    const rules = rulesOf({
      approvalMode: "auto-accept-edits",
      autonomy: null,
      alwaysPrefixes: [{ prefix: ["pnpm", "test"] }],
    });
    const h = harness(rules);
    await h.run("bash", fetch);
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]?.answers).toEqual(["deny", "once"]);
  });

  it("leaves MCP tools, unknown tools and Pi's own unsandboxed shell as they were", async () => {
    const tools = {
      bash: { path: "builtin:bash" },
      mcp__srv__write: { path: MCP_SOURCE },
      odd: { path: "/ext/odd.js" },
    };
    const rules = rulesOf({ sandbox: { required: false, network: true } });
    for (const [name, input] of [
      ["mcp__srv__write", { text: "x" }],
      ["odd", {}],
      ["bash", { command: "python3 -c 'print(1)'" }],
    ] as const) {
      const h = harness(rules, true, { tools });
      await h.run(name, input);
      expect(h.asks, name).toHaveLength(1);
      expect(h.asks[0]?.answers, name).toEqual(["deny", "once"]);
    }
  });

  it("leaves a write outside the folder and read-only mode as they were", async () => {
    const write = harness(rulesOf());
    await write.run("write", { path: join(bed.outside, "note.txt"), content: "y" });
    expect(write.asks).toHaveLength(1);
    expect(write.asks[0]?.answers).toEqual(["deny", "once"]);
    const readOnly = harness(rulesOf({ approvalMode: "read-only" }));
    expect(await readOnly.run("bash", command)).toMatchObject({ block: true });
    expect(readOnly.asks).toHaveLength(0);
  });

  it("keeps MC36's hold: under the read-only preset the question stays, Deny / Allow once", async () => {
    const h = harness(rulesOf({ readOnlyPreset: true }));
    await h.run("bash", command);
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]?.answers).toEqual(["deny", "once"]);
    expect(h.entries.at(-1)).not.toMatchObject({ reason: "trusted autonomy" });
  });

  it("gives a session that is not an agent thread nothing, a forged autonomy included", async () => {
    const interactive = harness(rulesOf({ profile: "interactive", agentHome: null }));
    await interactive.run("bash", command);
    expect(interactive.asks).toHaveLength(1);
    expect(interactive.asks[0]?.answers).toEqual(["deny", "once"]);
  });
});

describe("an isolated task with a forged autonomy (M11R217)", () => {
  it("is decided by decideIsolated exactly as without it", async () => {
    const scratch = join(
      bed.papHome,
      "agents",
      ".runs",
      "atlas-1a2b",
      "0a1b2c3d-0000-4000-8000-0123456789ab",
    );
    await mkdir(scratch, { recursive: true });
    const plan = (autonomy: object | null, tainted: boolean) => {
      const rules = rulesOf({
        profile: "isolated-task",
        approvalMode: "auto-accept-edits",
        agentScratch: scratch,
        autonomy,
      });
      const call = { ...callOf("bash", { command: PYTHON }, SANDBOX_NET, rules), cwd: scratch, tainted };
      return approvalStage(call, { hasUI: true, cwd: scratch }, {
        ...bed.deps,
        sessionId: () => undefined,
      } as never);
    };
    for (const tainted of [false, true]) {
      const forged = await plan({ hosts: ["allowed.example"] }, tainted);
      expect(forged).toEqual(await plan(null, tainted));
      expect(forged).toMatchObject({ outcome: "ask", answers: ["deny", "once"], grantable: false });
    }
  });
});
