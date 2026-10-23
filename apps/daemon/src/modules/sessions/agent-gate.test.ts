import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput, type PapError, type VmLayout } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureLogger } from "./testing/helpers.ts";
import { type AgentGateDeps, agentGate, type AgentProfile } from "./agent-gate.ts";
import type { SessionRow } from "./store.ts";

const ID = "atlas-1a2b";
let root: string;
let papHome: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-agent-gate-")));
  papHome = join(root, "pap");
  mkdirSync(join(papHome, "agents", ID), { recursive: true, mode: 0o700 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const row = (extra: Partial<SessionRow> = {}): SessionRow => ({
  id: "s1",
  piPath: null,
  piSessionId: null,
  cwd: join(papHome, "agents", ID),
  ownerId: "u1",
  name: null,
  createdAt: 0,
  updatedAt: 0,
  agentId: ID,
  agentRole: "thread",
  ...extra,
});

function deps(options: { profile?: AgentProfile | null; vm?: boolean } = {}) {
  const logs = captureLogger();
  const profile =
    options.profile === undefined
      ? { input: AgentInput.parse({ name: "Atlas", role: "Be brief." }), name: "Atlas", quarantined: false }
      : options.profile;
  const value: AgentGateDeps = {
    papHome,
    agentDir: join(root, "pi"),
    profileOf: () => profile,
    ...(options.vm === false ? {} : { vmLayoutOf: () => ({ home: "/agent/home" }) as VmLayout }),
    logger: logs.logger,
  };
  return { value, logs };
}
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: PapError) => error.code,
  );

describe("agentGate (M11R53): agents run in microVMs only", () => {
  it("a session with a VM layout gets the profile, the role and vm: true, and no sandbox", async () => {
    const launch = await agentGate(row(), deps().value);
    expect(launch).toMatchObject({
      agent: { id: ID, name: "Atlas", role: "Be brief." },
      role: "thread",
      vm: true,
    });
    expect(launch).not.toHaveProperty("sandbox");
  });

  it("without a VM layout (no VM stack) the start is refused sandbox_unavailable, and logged without the role", async () => {
    const { value, logs } = deps({ vm: false });
    expect(await codeOf(agentGate(row(), value))).toBe("sandbox_unavailable");
    expect(logs.lines.find((line) => line.msg === "agent_vm_unavailable")).toMatchObject({ agentId: ID });
    expect(JSON.stringify(logs.lines)).not.toContain("Be brief");
  });

  it("refuses a row without an agent", async () => {
    expect(await codeOf(agentGate(row({ agentId: undefined }), deps().value))).toBe("bad_request");
  });

  it("refuses a quarantined agent, a deleted one and a profile that does not parse", async () => {
    const quarantined = { input: AgentInput.parse({ name: "Atlas" }), name: "Atlas", quarantined: true };
    expect(await codeOf(agentGate(row(), deps({ profile: quarantined }).value))).toBe("agent_paused");
    expect(await codeOf(agentGate(row(), deps({ profile: null }).value))).toBe("not_found");
  });
});
