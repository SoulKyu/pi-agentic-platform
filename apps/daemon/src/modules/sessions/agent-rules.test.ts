import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput, PolicyRules } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Logger, silentLogger } from "../../kernel/logger.ts";
import { type AgentProfile } from "./agent-gate.ts";
import { createAgentRules, effectiveMode } from "./agent-rules.ts";
import type { SessionRow } from "./store.ts";

const ID = "atlas-1a2b";
const TASK = "0a1b2c3d-0000-4000-8000-0123456789ab";
let papHome: string;
let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-agent-rules-")));
  papHome = join(root, "pap");
  mkdirSync(papHome);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const row = (extra: Partial<SessionRow> = {}): SessionRow => ({
  id: "s1",
  piPath: null,
  piSessionId: null,
  cwd: join(root, "pap", "agents", ID),
  ownerId: "u1",
  name: null,
  createdAt: 0,
  updatedAt: 0,
  agentId: ID,
  agentRole: "thread",
  ...extra,
});
const pattern = (n: number) => `rm-${n}*`;
const OWNER = { allowHosts: ["owner.example"] as string[] | null, denylist: [] as string[] };

function build(input: object | null, logger: Logger = silentLogger, hostGrants: readonly string[] = []) {
  const profile: AgentProfile | null =
    input === null
      ? null
      : { input: AgentInput.parse({ name: "Atlas", ...input }), name: "Atlas", quarantined: false };
  return createAgentRules({ papHome, profileOf: () => profile, hostGrants: () => hostGrants, logger });
}

describe("the agent's rules (M11R52)", () => {
  it("a thread carries the agent's mode and hosts, the home and the sandbox", () => {
    const rules = build({
      mode: "supervised",
      allowHosts: ["a.example"],
      sandbox: { required: true, network: true },
    })(row(), OWNER);
    expect(rules).toMatchObject({
      profile: "agent-thread",
      approvalMode: "supervised",
      allowHosts: ["a.example"],
      agentHome: join(papHome, "agents", ID),
      agentScratch: null,
      sandbox: { required: true, network: true },
    });
  });

  it("an agent list of null follows the owner's list; an empty list stays empty", () => {
    expect(build({})(row(), OWNER)).toMatchObject({ allowHosts: ["owner.example"] });
    expect(build({ allowHosts: [] })(row(), OWNER)).toMatchObject({ allowHosts: [] });
  });

  it("the owner's patterns come first, then the agent's: 64 + 50 give 114", () => {
    const owner = { allowHosts: null, denylist: Array.from({ length: 64 }, (_, n) => pattern(n)) };
    const agent = Array.from({ length: 50 }, (_, n) => pattern(100 + n));
    const rules = build({ denylist: agent })(row(), owner);
    expect(rules.denylist).toHaveLength(114);
    expect(rules.denylist?.[0]).toBe(pattern(0));
    expect(rules.denylist?.[64]).toBe(pattern(100));
  });

  it("a task keeps the task's mode (no approvalMode of its own) and names its scratch folder", () => {
    const scratch = join(papHome, "agents", ".runs", ID, TASK);
    const rules = build({ mode: "full-access" })(row({ agentRole: "task", cwd: scratch }), OWNER);
    expect(rules).toMatchObject({
      profile: "isolated-task",
      agentScratch: scratch,
      agentHome: join(papHome, "agents", ID),
    });
    expect(rules).not.toHaveProperty("approvalMode");
  });

  it("a thread carries the profile's trusted sources and the daemon's host grants (owner a1, a2)", () => {
    const rules = build({ trustedSources: ["docs.example.com"] }, silentLogger, ["api.example.com"])(
      row(),
      OWNER,
    );
    expect(rules).toMatchObject({ trustedSources: ["docs.example.com"], hostGrants: ["api.example.com"] });
  });

  it("a task carries the trusted sources and never a host grant", () => {
    const scratch = join(papHome, "agents", ".runs", ID, TASK);
    const rules = build({ trustedSources: ["docs.example.com"] }, silentLogger, ["api.example.com"])(
      row({ agentRole: "task", cwd: scratch }),
      OWNER,
    );
    expect(rules).toMatchObject({ trustedSources: ["docs.example.com"], hostGrants: [] });
  });

  it("a child carries neither", () => {
    const rules = build({ trustedSources: ["docs.example.com"] }, silentLogger, ["api.example.com"])(
      row({ agentRole: "child" }),
      OWNER,
    );
    expect(rules).toMatchObject({ trustedSources: [], hostGrants: [] });
  });

  it("the parts make valid rules", () => {
    const parts = build({})(row(), OWNER);
    expect(PolicyRules.safeParse({ approvalMode: "supervised", ...parts }).success).toBe(true);
  });

  it("a profile that does not parse composes read-only rules and logs once", () => {
    const lines: string[] = [];
    const logger = {
      ...silentLogger,
      warn: (msg: string) => void lines.push(msg),
      child: () => logger,
    } as Logger;
    const compose = build(null, logger);
    for (let n = 0; n < 3; n += 1) {
      expect(compose(row(), OWNER)).toMatchObject({
        profile: "agent-thread",
        approvalMode: "read-only",
        sandbox: { required: true, network: false },
      });
    }
    expect(lines).toEqual(["agent_profile_unreadable"]);
  });
});

describe("the effective mode of an agent thread (W5-R23)", () => {
  it("is the stricter of the profile's and the session's own, never looser than the profile", () => {
    expect(effectiveMode("auto-accept-edits", { mode: "read-only", explicit: true })).toEqual({
      mode: "read-only",
      explicit: true,
    });
    expect(effectiveMode("supervised", { mode: "full-access", explicit: true })).toEqual({
      mode: "supervised",
      explicit: false,
    });
    expect(effectiveMode("supervised", { mode: "supervised", explicit: true })).toEqual({
      mode: "supervised",
      explicit: false,
    });
  });

  it("follows the profile when the session has no mode of its own", () => {
    expect(effectiveMode("auto-accept-edits", { mode: "read-only", explicit: false })).toEqual({
      mode: "auto-accept-edits",
      explicit: false,
    });
  });

  it("the rules of a thread carry it; a task keeps the task's", () => {
    const owner = { ...OWNER, session: { mode: "read-only" as const, explicit: true } };
    expect(build({ mode: "auto-accept-edits" })(row(), owner)).toMatchObject({ approvalMode: "read-only" });
    const loose = { ...OWNER, session: { mode: "full-access" as const, explicit: true } };
    expect(build({ mode: "supervised" })(row(), loose)).toMatchObject({ approvalMode: "supervised" });
    expect(build({ mode: "supervised" })(row({ agentRole: "task", cwd: "/x" }), owner)).not.toHaveProperty(
      "approvalMode",
    );
  });
});

describe("trusted autonomy in the rules (owner a6, M11R218)", () => {
  const on = { trustedAutonomy: true, allowHosts: ["a.example"] };
  it("a thread carries its own hosts, [] when it has none, and null when it is off", () => {
    expect(build(on)(row(), OWNER).autonomy).toEqual({ hosts: ["a.example"] });
    expect(build({ trustedAutonomy: true })(row(), OWNER).autonomy).toEqual({ hosts: [] });
    expect(build({})(row(), OWNER).autonomy).toBeNull();
  });
  it("an isolated task, a child and a missing profile never carry it", () => {
    expect(build(on)(row({ agentRole: "task", cwd: join(root, "scratch") }), OWNER).autonomy).toBeNull();
    expect(build(on)(row({ agentRole: "child" }), OWNER).autonomy).toBeNull();
    expect(build(null)(row(), OWNER).autonomy).toBeUndefined();
  });
});
