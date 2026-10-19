import { InitRecord, PolicyRules, type VmInit } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { layoutOf } from "./layouts.ts";
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
  sandbox: {
    bwrap: "/usr/bin/bwrap",
    view: "host",
    home: `${PAP_HOME}/agents/atlas-1a2b`,
    writable: `${PAP_HOME}/agents/atlas-1a2b`,
    network: false,
    egress: null,
    hide: [PAP_HOME],
  },
  vault: { TOKEN: "s3cret" },
  once: [{ id: "o".repeat(8), name: "ONE", value: "v", expiresAt: 5 }],
  agent: { id: "atlas-1a2b", name: "Atlas", role: "r" },
  memory: { profile: "atlas", trust: "trusted" },
  testProviderScript: `${PAP_HOME}/script.json`,
  policy: vmRules,
};

describe("vmInitOf (R11, R17, RT-06)", () => {
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
  it("carries no sandbox, vault, once or memory, and no secret.request op", () => {
    for (const key of ["sandbox", "vault", "once", "memory", "testProviderScript"])
      expect(out).not.toHaveProperty(key);
    expect(out.platform?.ops).toEqual(["agent.approve"]);
    expect(JSON.stringify(out)).not.toContain("s3cret");
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
  it("accepts a task's scratch inside the VM", () => {
    const task = rulesOf({ agentHome: layout.home, agentScratch: layout.home });
    expect(vmInitOf({ ...host, policy: task }, vm, null).policy).toMatchObject({ agentScratch: layout.home });
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
