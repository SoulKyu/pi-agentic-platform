import { type Mock, vi } from "vitest";
import { type AgentsVmLate, bindAgentsVmLate } from "../compose-agents-vm-late.ts";
import { createFakeClock } from "../kernel/clock.ts";
import { silentLogger } from "../kernel/logger.ts";
import type { MirrorHooks } from "../modules/agent-vm/index.ts";
import { sharesAllProviders } from "./shares-all.ts";

export const OWNER = "u1";
export const AGENT = "scout-0001";

export function bed(
  over: {
    paused?: boolean;
    over?: boolean;
    models?: Array<{ provider: string; id: string }>;
    token?: boolean;
    input?: { model: { provider: string } | null; packages: string[] | null };
  } = {},
) {
  const clock = createFakeClock();
  const hooks: { value: MirrorHooks | null } = { value: null };
  const mirror: { notice: Mock; taint: Mock } = { notice: vi.fn(), taint: vi.fn() };
  const listeners = {
    models: [] as Array<() => void>,
    agent: [] as Array<(change: { agentId: string }) => void>,
    start: [] as Array<(sessionId: string) => void>,
    end: [] as Array<(event: { sessionId: string }) => void>,
  };
  const relay: { refresh: Mock; refreshAll: Mock } = { refresh: vi.fn(), refreshAll: vi.fn() };
  const closers: Array<{ name: string; close(): void | Promise<void> }> = [];
  const state = {
    paused: over.paused ?? false,
    over: over.over ?? false,
    disabled: false,
    fail: false,
    token: over.token ?? false,
    quarantinedAt: null as number | null,
  };
  const late: AgentsVmLate = {
    providers: sharesAllProviders,
    memberLine: { over: () => false, disabled: () => state.disabled },
    sessions: { mirror, kindOf: (id) => (id === "s1" ? { agentId: AGENT } : null) },
    pi: {
      // The tests give the picks as the sources themselves: the identity stands for the helper's resolution.
      plugins: { sourcesOf: async (ids) => (ids === null ? null : [...ids]), check: async () => {} },
      models: {
        available: vi.fn(async () => {
          if (state.fail) throw new Error("helper pool is full");
          return {
            models: (over.models ?? [{ provider: "acme", id: "m-1" }]).map((m) => ({
              ...m,
              name: m.id,
              reasoning: false,
            })),
            providers: [],
            origin: "signed-in" as const,
            truncated: false,
          };
        }),
        onChanged: (listener) => void listeners.models.push(listener),
      },
    },
    agents: {
      list: () => [],
      ownerOf: (id) => (id === AGENT ? OWNER : null),
      get: (_owner, id) =>
        id === AGENT
          ? ({
              paused: state.paused,
              quarantinedAt: state.quarantinedAt,
              input: over.input ?? { model: null, packages: null },
            } as never)
          : null,
      onChange: (listener) => (listeners.agent.push(listener as never), () => {}),
    },
    runs: {
      port: {
        onLiveCost: (listener) => (listeners.start.push(listener as never), () => {}),
        onRunEnd: (listener) => (listeners.end.push(listener as never), () => {}),
      },
    },
    automation: { agentTasks: { overBudget: () => state.over, ownerOverBudget: () => state.over } },
  };
  const derived = bindAgentsVmLate(
    {
      clock,
      logger: silentLogger,
      closers,
      relay: relay as never,
      claudeToken: { get: () => (state.token ? "tok-x" : null) },
      readOnly: false,
      bindMirrorHooks: (next) => void (hooks.value = next),
      bindTaint: () => {},
    },
    late,
  );
  return { clock, hooks, mirror, listeners, relay, closers, state, derived, late };
}
