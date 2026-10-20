import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput, PolicyRules } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { layoutOf, vmInitOf } from "../agent-vm/index.ts";
import { createAgentRules } from "./agent-rules.ts";
import type { SessionRow } from "./store.ts";

const ID = "atlas-1a2b";
let root: string;
const layout = layoutOf("kata", "/unused", { agentId: ID, taskKey: null });
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-agent-rules-vm-")));
  mkdirSync(join(root, "agents"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const row = (extra: Partial<SessionRow> = {}): SessionRow => ({
  id: "s1",
  piPath: null,
  piSessionId: null,
  cwd: join(root, "agents", ID),
  ownerId: "u1",
  name: null,
  createdAt: 0,
  updatedAt: 0,
  agentId: ID,
  agentRole: "thread",
  ...extra,
});
const OWNER = { allowHosts: ["owner.example"] as string[] | null, denylist: [] as string[] };

function rulesFor(vm: boolean, input: object = {}, valid = true) {
  const profile = valid
    ? { input: AgentInput.parse({ name: "Atlas", ...input }), name: "Atlas", quarantined: false }
    : null;
  return createAgentRules({
    papHome: root,
    profileOf: () => profile,
    hostGrants: () => [],
    logger: silentLogger,
    vmLayoutOf: () => (vm ? layout : null),
  });
}

describe("the rules of a VM session (R15)", () => {
  it("composes the VM parts at the first compose, whatever the profile's sandbox says", () => {
    const rules = rulesFor(true, { sandbox: { required: false, network: true }, mode: "full-access" })(
      row(),
      OWNER,
    );
    expect(rules).toMatchObject({
      sandbox: { required: true, network: false },
      agentHome: layout.home,
      agentScratch: null,
      approvalMode: "full-access",
    });
  });
  it("keeps them at every later compose, after a policy update", () => {
    const agentRules = rulesFor(true, { sandbox: { required: false, network: true } });
    agentRules(row(), OWNER);
    const again = agentRules(row(), {
      ...OWNER,
      denylist: ["rm*"],
      session: { mode: "supervised", explicit: true },
    });
    expect(again).toMatchObject({
      sandbox: { required: true, network: false },
      agentHome: layout.home,
      approvalMode: "supervised",
      denylist: ["rm*"],
    });
  });
  it("gives an isolated task its VM's home as scratch", () => {
    expect(rulesFor(true)(row({ agentRole: "task", cwd: "/x" }), OWNER)).toMatchObject({
      profile: "isolated-task",
      agentScratch: layout.home,
    });
  });
  it("also holds when the profile does not read", () => {
    expect(rulesFor(true, {}, false)(row(), OWNER)).toMatchObject({
      approvalMode: "read-only",
      agentHome: layout.home,
      sandbox: { required: true, network: false },
    });
  });
  it("leaves a host row on the host's home", () => {
    expect(rulesFor(false)(row(), OWNER)).toMatchObject({ agentHome: join(root, "agents", ID) });
  });

  // The way `policy-link` composes: the owner's grants first, the agent's parts spread after (AVM-E18).
  const OWNER_GRANTS = {
    alwaysAllow: [{ tool: "bash", key: "a".repeat(64) }],
    alwaysPrefixes: [{ prefix: ["git", "status"] }],
    alwaysTools: [{ tool: "mcp__fix__write", source: "mcp" as const }],
  };
  const composed = (vm: boolean) =>
    PolicyRules.parse({
      profile: "interactive",
      approvalMode: "supervised",
      ...OWNER_GRANTS,
      ...rulesFor(vm)(row(), OWNER),
    });

  it("empties the owner's three kinds of always rules for a VM session, and vmInitOf then accepts the rules", () => {
    const rules = composed(true);
    expect([rules.alwaysAllow, rules.alwaysPrefixes, rules.alwaysTools]).toEqual([[], [], []]);
    const vm = {
      layout,
      bwrap: "/usr/bin/bwrap",
      relayKey: "ab".repeat(32),
      slot: "cd".repeat(16),
      rootView: "overlay" as const,
    };
    const init = {
      type: "init" as const,
      cwd: "/h",
      agentDir: "/h",
      papHome: "/h",
      umask: 0o22,
      policy: rules,
    };
    expect(() => vmInitOf(init, vm, null)).not.toThrow();
  });
  it("leaves a host session of the same owner its rules", () => {
    const rules = composed(false);
    expect(rules.alwaysAllow).toEqual(OWNER_GRANTS.alwaysAllow);
    expect(rules.alwaysPrefixes).toEqual(OWNER_GRANTS.alwaysPrefixes);
    expect(rules.alwaysTools).toEqual(OWNER_GRANTS.alwaysTools);
  });
});
