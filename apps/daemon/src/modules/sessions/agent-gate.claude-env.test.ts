import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput, type VmLayout } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentGateDeps, agentGate } from "./agent-gate.ts";
import type { SessionRow } from "./store.ts";
import { captureLogger } from "./testing/helpers.ts";

const ID = "atlas-1a2b";
let root: string;
let papHome: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-gate-claude-")));
  papHome = join(root, "pap");
  mkdirSync(join(papHome, "agents", ID), { recursive: true, mode: 0o700 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const row = (): SessionRow =>
  ({
    id: "s1",
    ownerId: "u1",
    agentId: ID,
    agentRole: "thread",
    cwd: join(papHome, "agents", ID),
  }) as SessionRow;
const VM_HOME = "/agent/home";
function deps(bridge: boolean, vm: boolean) {
  const asked: Array<{ vm: boolean; home: string }> = [];
  const value: AgentGateDeps = {
    papHome,
    agentDir: join(root, "pi"),
    profileOf: () => ({
      input: AgentInput.parse({ name: "Atlas", sandbox: { required: false } }),
      name: "Atlas",
      quarantined: false,
    }),
    ...(vm ? { vmLayoutOf: () => ({ home: VM_HOME }) as VmLayout } : {}),
    claudeEnvOf: (_input, where) => {
      asked.push(where);
      return Promise.resolve<Record<string, string>>(
        bridge ? { CLAUDE_CONFIG_DIR: `${where.home}/.claude` } : {},
      );
    },
    probe: { ensure: () => Promise.reject(new Error("no probe")) },
    logger: captureLogger().logger,
  };
  return { value, asked };
}

describe("the launch gate and the Claude Code environment (ADR 0080)", () => {
  it("carries a host bridge agent's environment, asked for its real home", async () => {
    const { value, asked } = deps(true, false);
    const launch = await agentGate(row(), value);
    const home = join(papHome, "agents", ID);
    expect(asked).toEqual([{ vm: false, home }]);
    expect(launch.claudeEnv).toEqual({ CLAUDE_CONFIG_DIR: `${home}/.claude` });
  });

  it("carries a VM bridge agent's environment, asked for the layout's home", async () => {
    const { value, asked } = deps(true, true);
    const launch = await agentGate(row(), value);
    expect(asked).toEqual([{ vm: true, home: VM_HOME }]);
    expect(launch.claudeEnv).toEqual({ CLAUDE_CONFIG_DIR: `${VM_HOME}/.claude` });
    expect(launch.vm).toBe(true);
  });

  it("leaves the launch of any other agent untouched", async () => {
    for (const vm of [false, true]) {
      const { value } = deps(false, vm);
      expect(await agentGate(row(), value)).not.toHaveProperty("claudeEnv");
    }
  });
});
