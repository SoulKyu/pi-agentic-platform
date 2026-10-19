import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { layoutOf } from "../agent-vm/index.ts";
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
});
