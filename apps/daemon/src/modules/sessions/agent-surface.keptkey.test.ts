import { describe, expect, it, vi } from "vitest";
import { createAgentSurface } from "./agent-surface.ts";
import type { SessionRow } from "./store.ts";

const KEEP = "d".repeat(32);

const row = (agentRole: SessionRow["agentRole"], extra: Partial<SessionRow> = {}): SessionRow => ({
  id: "s1",
  piPath: null,
  piSessionId: null,
  cwd: "/home/u/agent",
  ownerId: "u1",
  name: null,
  createdAt: 0,
  updatedAt: 0,
  agentId: "atlas-0001",
  agentRole,
  ...extra,
});

function setup(keptKeyOf?: (ownerId: string, sessionId: string) => string | null) {
  const surface = createAgentSurface({
    store: { get: () => undefined, readOnly: false } as never,
    policy: {} as never,
    clock: {} as never,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    worker: { papHome: "/pap", agentDir: "/pi" },
  });
  surface.setAgentPorts({
    agents: { profileOf: () => null, ...(keptKeyOf ? { keptKeyOf } : {}) },
  });
  return surface;
}

describe("a relaunched task session asks again for its kept folder key (I2)", () => {
  it("carries the key the port answers for a task row, and asks for the row's owner and id", () => {
    const keptKeyOf = vi.fn(() => KEEP);
    const relaunched = setup(keptKeyOf).withKeptKey(row("task"));
    expect(relaunched.keptKey).toBe(KEEP);
    expect(keptKeyOf).toHaveBeenCalledExactlyOnceWith("u1", "s1");
  });

  it("leaves the row as it is when the port says none, is not bound, or the row is no task", () => {
    const task = row("task");
    expect(setup(() => null).withKeptKey(task)).toBe(task);
    expect(setup().withKeptKey(task)).toBe(task);
    const keptKeyOf = vi.fn(() => KEEP);
    const thread = row("thread");
    expect(setup(keptKeyOf).withKeptKey(thread)).toBe(thread);
    expect(keptKeyOf).not.toHaveBeenCalled();
  });
});
