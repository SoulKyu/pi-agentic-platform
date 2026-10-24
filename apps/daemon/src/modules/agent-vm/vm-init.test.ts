import { InitRecord, PolicyRules, type VmInit } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { layoutOf } from "./layouts.ts";
import { projectLayoutOf } from "./project-layout.ts";
import { vmInitOf } from "./vm-init.ts";

const PAP_HOME = "/host/pap-home";
const PI_DIR = "/host/pi-agent";
const layout = layoutOf("kata", PAP_HOME, { agentId: "atlas-1a2b", taskKey: null });
const vm: VmInit = {
  layout,
  bwrap: "/usr/bin/bwrap",
  relayKey: "ab".repeat(32),
  slot: "cd".repeat(16),
  rootView: "overlay",
};
const rulesOf = (extra: object) =>
  PolicyRules.parse({ profile: "agent-thread", approvalMode: "supervised", ...extra });
const hostRules = rulesOf({
  agentHome: `${PAP_HOME}/agents/atlas-1a2b`,
  agentScratch: `${PAP_HOME}/agents/.runs/atlas-1a2b/t1`,
  sandbox: { required: false, network: true },
});
const vmRules = rulesOf({
  agentHome: layout.home,
  agentScratch: null,
  sandbox: { required: true, network: false },
});
const host: InitRecord = {
  type: "init",
  cwd: `${PAP_HOME}/agents/atlas-1a2b`,
  agentDir: PI_DIR,
  papHome: PAP_HOME,
  umask: 0o022,
  sessionFile: `${PAP_HOME}/agents/.mirrors/atlas-1a2b/s.jsonl`,
  papSessionId: "s1",
  platform: { ops: ["secret.request", "agent.approve"] },
  vault: { TOKEN: "s3cret" },
  once: [{ id: "o".repeat(8), name: "ONE", value: "v", expiresAt: 5 }],
  agent: { id: "atlas-1a2b", name: "Atlas", role: "r" },
  testProviderScript: `${PAP_HOME}/script.json`,
  policy: vmRules,
};

describe("vmInitOf (R17, RT-06)", () => {
  const out = vmInitOf(host, vm, "s.jsonl");
  it("translates the paths to the VM's layout", () => {
    expect(out.cwd).toBe(layout.home);
    expect(out.agentDir).toBe(layout.piAgentDir);
    expect(out.papHome).toBe(`${layout.pi}/pap`);
    expect(out.sessionFile).toBe(`${layout.sessions}/s.jsonl`);
    expect(out.vm).toBe(vm);
  });
  it("keeps no host path anywhere in the record", () => {
    const text = JSON.stringify(out);
    expect(text).not.toContain(PAP_HOME);
    expect(text).not.toContain(PI_DIR);
    expect(text).not.toContain("script.json");
  });
  it("carries the vault, the one-use values and the secret.request op, (ADR 0081)", () => {
    for (const key of ["testProviderScript"]) expect(out).not.toHaveProperty(key);
    expect(out.vault).toEqual({ TOKEN: "s3cret" });
    expect(out.once).toEqual(host.once);
    expect(out.platform?.ops).toEqual(["secret.request", "agent.approve"]);
  });
  it("a thread VM gets its knowledge bundle (SP5)", () => {
    expect(out.knowledge).toEqual({ path: layout.knowledge });
    expect(InitRecord.safeParse(out).success).toBe(true);
  });
  it("a task VM gets none, and a host-composed knowledge is dropped", () => {
    const task = rulesOf({
      agentHome: layout.home,
      agentScratch: layout.home,
      sandbox: { required: true, network: false },
    });
    const given = { ...host, policy: task, knowledge: { path: "/host/project/knowledge" } };
    expect(vmInitOf(given, vm, null)).not.toHaveProperty("knowledge");
    const isolated = rulesOf({ profile: "isolated-task", agentHome: layout.home, sandbox: vmRules.sandbox });
    expect(vmInitOf({ ...given, policy: isolated }, vm, null)).not.toHaveProperty("knowledge");
  });
  it("names no sessionFile without a mirror (Pi creates it in layout.sessions)", () => {
    expect(vmInitOf(host, vm, null)).not.toHaveProperty("sessionFile");
  });
  it("keeps the other fields and still parses as an init record", () => {
    expect(out).toMatchObject({ type: "init", umask: 0o022, papSessionId: "s1" });
    expect(out.agent).toEqual(host.agent);
    const parsed = InitRecord.safeParse(out);
    expect(parsed.error?.issues).toBeUndefined();
  });
  it("refuses host-composed rules: a home or scratch outside the VM's root, or one that steps out of it", () => {
    for (const bad of [
      hostRules,
      rulesOf({ agentHome: `${PAP_HOME}/x` }),
      rulesOf({ agentScratch: "/agent2/x" }),
    ])
      expect(() => vmInitOf({ ...host, policy: bad }, vm, null)).toThrow(
        expect.objectContaining({ code: "bad_request" }),
      );
    expect(() =>
      vmInitOf({ ...host, policy: rulesOf({ agentHome: `${layout.root}/../etc` }) }, vm, null),
    ).toThrow(expect.objectContaining({ code: "bad_request" }));
  });
  it("refuses rules that do not parse, and an always grant made for a host call", () => {
    for (const bad of [
      { rules: 1 },
      undefined,
      null,
      { ...vmRules, alwaysAllow: [{ tool: "bash", key: "a".repeat(64) }] },
    ])
      expect(() => vmInitOf({ ...host, policy: bad }, vm, null)).toThrow(
        expect.objectContaining({ code: "bad_request" }),
      );
  });
  it("refuses prefix and tool always rules too", () => {
    for (const extra of [
      { alwaysPrefixes: [{ prefix: ["ls"] }] },
      { alwaysTools: [{ tool: "t", source: "mcp" }] },
    ])
      expect(() => vmInitOf({ ...host, policy: { ...vmRules, ...extra } }, vm, null)).toThrow(
        expect.objectContaining({ code: "bad_request" }),
      );
  });
  it("accepts a task's scratch inside the VM", () => {
    const task = rulesOf({
      agentHome: layout.home,
      agentScratch: layout.home,
      sandbox: { required: true, network: false },
    });
    expect(vmInitOf({ ...host, policy: task }, vm, null).policy).toMatchObject({ agentScratch: layout.home });
  });
  // Mutant: the `sandbox.required` / `network` check removed from vmRulesOf. Killed by the next two cases.
  it("refuses rules without the VM's fixed sandbox (T8a): none or not required; the network is the agent's (AVM2-E11)", () => {
    const vmRules = rulesOf({ agentHome: layout.home, sandbox: { required: true, network: true } });
    expect(vmInitOf({ ...host, policy: vmRules }, vm, null).policy).toMatchObject({
      sandbox: { required: true, network: true },
    });
    for (const sandbox of [null, { required: false, network: false }, { required: false, network: true }])
      expect(() =>
        vmInitOf({ ...host, policy: rulesOf({ agentHome: layout.home, sandbox }) }, vm, null),
      ).toThrow(expect.objectContaining({ code: "internal" }));
  });
  it("refuses a mirror file that is not one session file name", () => {
    for (const file of ["../x.jsonl", "a/b.jsonl", "x.json"])
      expect(() => vmInitOf(host, vm, file)).toThrow(expect.objectContaining({ code: "bad_request" }));
  });
  it("does not change its input", () => {
    expect(host.vault).toEqual({ TOKEN: "s3cret" });
    expect(host.platform?.ops).toContain("secret.request");
  });
});

describe("vmInitOf for a project box", () => {
  const box = projectLayoutOf("kata", PAP_HOME, "6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d11");
  const boxVm: VmInit = { ...vm, layout: box };
  const projectRules = rulesOf({
    profile: "project",
    agentHome: box.project,
    agentScratch: null,
    sandbox: { required: true, network: true },
  });
  const hostRecord: InitRecord = {
    type: "init",
    cwd: "/host/projects/p",
    agentDir: PI_DIR,
    papHome: PAP_HOME,
    umask: 0o022,
    papSessionId: "s1",
    platform: { ops: [] },
    testProviderScript: `${PAP_HOME}/script.json`,
    policy: projectRules,
  };

  it("composes project rules with cwd and own folder at the project", () => {
    const out = vmInitOf(hostRecord, boxVm, null);
    expect(out.cwd).toBe(box.project);
    expect(out.policy).toMatchObject({ profile: "project", agentHome: box.project, agentScratch: null });
    expect(out.agentDir).toBe(box.piAgentDir);
    expect(out.papHome).toBe(`${box.pi}/pap`);
    expect(InitRecord.safeParse(out).success).toBe(true);
  });
  it("always names the project's knowledge folder, whatever the host composed", () => {
    expect(vmInitOf(hostRecord, boxVm, null).knowledge).toEqual({ path: `${box.project}/knowledge` });
    const given = { ...hostRecord, knowledge: { path: "/host/projects/p/knowledge" } };
    expect(vmInitOf(given, boxVm, null).knowledge).toEqual({ path: `${box.project}/knowledge` });
  });
  it("keeps no host path in the record", () => {
    const text = JSON.stringify(vmInitOf(hostRecord, boxVm, null));
    for (const hostPath of [PAP_HOME, PI_DIR, "/host/projects"]) expect(text).not.toContain(hostPath);
  });
  it("refuses a project layout with agent rules, and project rules in an agent layout", () => {
    expect(() => vmInitOf({ ...hostRecord, policy: vmRules }, boxVm, null)).toThrow(
      expect.objectContaining({ code: "bad_request" }),
    );
    expect(() => vmInitOf({ ...hostRecord, policy: projectRules }, vm, null)).toThrow(
      expect.objectContaining({ code: "bad_request" }),
    );
  });
  it("refuses project rules whose own folder is not the project (the home, the root)", () => {
    for (const agentHome of [box.home, box.root])
      expect(() =>
        vmInitOf({ ...hostRecord, policy: rulesOf({ ...projectRules, agentHome }) }, boxVm, null),
      ).toThrow(expect.objectContaining({ code: "bad_request" }));
  });
});
