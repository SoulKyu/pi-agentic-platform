import { describe, expect, it, vi } from "vitest";
import { type AgentsVmLate, bindAgentsVmLate } from "./compose-agents-vm-late.ts";
import { createFakeClock } from "./kernel/clock.ts";
import { silentLogger } from "./kernel/logger.ts";
import { createFakeProjectBoxSource } from "./kernel/testing/fake-boxes.ts";
import { boxRow, PROJECT } from "./testing/late-boxes.ts";

const ROOT = `/boxes/${PROJECT}`;

function bed(cwds: Record<string, string>, tainted: Set<string>, agentOf: Record<string, string> = {}) {
  const listeners: Array<(ownerId: string, sessionId: string) => void> = [];
  const raised = vi.fn();
  const late = {
    sessions: {
      mirror: { notice: () => {}, taint: () => {} },
      kindOf: (id: string) => ({ agentId: agentOf[id] ?? null }),
      cwdOf: (_owner: string, id: string) => cwds[id] ?? null,
    },
    policy: {
      onSessionChange: (listener: (ownerId: string, sessionId: string) => void) => {
        listeners.push(listener);
        return () => {};
      },
      sessionPolicy: (_owner: string, id: string) => ({ taint: { tainted: tainted.has(id) } }),
    },
    pi: {
      plugins: { sourcesOf: async () => null, check: async () => {} },
      models: { available: async () => ({ models: [] }), onChanged: () => {} },
    },
    agents: { list: () => [], ownerOf: () => null, get: () => null, onChange: () => () => {} },
    runs: { port: { onLiveCost: () => () => {}, onRunEnd: () => () => {} } },
    automation: { agentTasks: { overBudget: () => false, ownerOverBudget: () => false } },
    boxes: { source: createFakeProjectBoxSource({ [PROJECT]: boxRow() }) },
  } as unknown as AgentsVmLate;
  const derived = bindAgentsVmLate(
    {
      clock: createFakeClock(),
      logger: silentLogger,
      closers: [],
      relay: null,
      claudeToken: { status: () => "missing" },
      readOnly: false,
      bindMirrorHooks: () => {},
      bindTaint: () => {},
      launchRaised: raised,
    },
    late,
  );
  return { derived, raised, change: (id: string) => listeners.forEach((l) => l("u1", id)) };
}

describe("a project box session's taint reaches its launch (spec 4)", () => {
  it("raises the launch for a tainted box session only", () => {
    const b = bed(
      { box: ROOT, sub: `${ROOT}/src`, host: "/home/u/work", agent: ROOT },
      new Set(["box", "sub", "host", "agent", "clean"]),
      { agent: "atlas-1a2b" },
    );
    b.change("box");
    b.change("sub");
    b.change("host");
    b.change("agent");
    expect(b.raised.mock.calls).toEqual([["box"], ["sub"]]);
  });

  it("ignores a change that carries no taint", () => {
    const b = bed({ box: ROOT }, new Set());
    b.change("box");
    expect(b.raised).not.toHaveBeenCalled();
  });

  it("tells whether a session is tainted now, false when the policy fails", () => {
    const b = bed({}, new Set(["t"]));
    expect(b.derived.taintedNow("u1", "t")).toBe(true);
    expect(b.derived.taintedNow("u1", "x")).toBe(false);
  });
});
