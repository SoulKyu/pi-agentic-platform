import type { BoxRef } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { type AlwaysOnComposition, composeAlwaysOn } from "./compose-always-on.ts";
import { silentLogger } from "./kernel/logger.ts";
import type { AlwaysOnHooks } from "./modules/agent-vm/index.ts";

interface FakeAgent {
  id: string;
  alwaysOn: boolean;
  paused: boolean;
  quarantinedAt: number | null;
  threadSessionId: string | null;
  unreadable?: boolean;
}

const agent = (id: string, over: Partial<FakeAgent> = {}): FakeAgent => ({
  id,
  alwaysOn: true,
  paused: false,
  quarantinedAt: null,
  threadSessionId: null,
  ...over,
});

function bed(input: {
  agents?: Record<string, FakeAgent[]>;
  projects?: Record<string, Array<{ id: string; alwaysOn: boolean; deleting: boolean }>>;
  disabled?: string[];
}) {
  const agents = input.agents ?? {};
  const projects = input.projects ?? {};
  let hooks: AlwaysOnHooks | undefined;
  let onChange: (event: { ownerId: string; agentId: string; removed?: boolean }) => void = () => {};
  const started: string[] = [];
  const refreshIdle = vi.fn<(box: BoxRef) => void>();
  const touchIdle = vi.fn<(ownerId: string, sessionId: string) => void>();
  const record = (ownerId: string, a: FakeAgent) =>
    a.unreadable
      ? (() => {
          throw new Error("unreadable profile");
        })()
      : {
          id: a.id,
          ownerId,
          paused: a.paused,
          quarantinedAt: a.quarantinedAt,
          threadSessionId: a.threadSessionId,
          input: { alwaysOn: a.alwaysOn },
        };
  const modules = {
    logger: silentLogger,
    closers: [],
    auth: {
      ownerId: () => "o1",
      users: () => [{ id: "o1" }, { id: "o2" }],
      isDisabled: (id: string) => (input.disabled ?? []).includes(id),
    },
    agentsVm: {
      runtime: { bindAlwaysOn: (h: AlwaysOnHooks) => void (hooks = h), refreshIdle },
      startAgent: async (_ownerId: string, id: string) => void started.push(`agent:${id}`),
    },
    m11: {
      agents: {
        list: (ownerId: string) =>
          (agents[ownerId] ?? []).flatMap((a) => {
            try {
              return [record(ownerId, a)];
            } catch {
              return [];
            }
          }),
        get: (ownerId: string, id: string) => {
          const found = (agents[ownerId] ?? []).find((a) => a.id === id);
          return found ? record(ownerId, found) : null;
        },
        onChange: (listener: typeof onChange) => {
          onChange = listener;
          return () => {};
        },
      },
    },
    sessions: { bindKeepWorker: () => {}, touchIdle },
    projects: { port: { onAlwaysOnChange: () => () => {} } },
    boxes: {
      control: { start: async (id: string) => void started.push(`project:${id}`) },
      workspace: {
        boxes: () => ({
          ownerBoxes: (ownerId: string) => (projects[ownerId] ?? []).map((p) => p.id),
          box: (id: string) =>
            Object.values(projects)
              .flat()
              .find((p) => p.id === id) ?? null,
        }),
      },
    },
  } as unknown as AlwaysOnComposition;
  const composed = composeAlwaysOn(modules);
  return {
    agents,
    started,
    refreshIdle,
    touchIdle,
    composed,
    holds: (box: BoxRef) => hooks?.holds(box) ?? false,
    change: (ownerId: string, agentId: string) => onChange({ ownerId, agentId }),
    exitedStarts: async () => {
      await Promise.resolve();
      await Promise.resolve();
      return started;
    },
  };
}

describe("composeAlwaysOn", () => {
  it("R6: resuming an always-on agent starts its box once; a plain agent's resume starts nothing", async () => {
    const t = bed({
      agents: { o1: [agent("a", { paused: true }), agent("b", { alwaysOn: false, paused: true })] },
    });
    for (const a of t.agents.o1 ?? []) a.paused = false;
    t.change("o1", "a");
    t.change("o1", "b");
    expect(await t.exitedStarts()).toEqual(["agent:a"]);
  });

  it("R4: skips a disabled owner's, a paused, a quarantined and an unreadable agent, and a deleting project", () => {
    const t = bed({
      disabled: ["o2"],
      agents: {
        o1: [
          agent("ok"),
          agent("paused", { paused: true }),
          agent("quarantined", { quarantinedAt: 5 }),
          agent("broken", { unreadable: true }),
        ],
        o2: [agent("theirs")],
      },
      projects: {
        o1: [
          { id: "p-ok", alwaysOn: true, deleting: false },
          { id: "p-deleting", alwaysOn: true, deleting: true },
          { id: "p-off", alwaysOn: false, deleting: false },
        ],
      },
    });
    const agentBox = (id: string): BoxRef => ({ kind: "agent", id });
    const projectBox = (id: string): BoxRef => ({ kind: "project", id });
    expect(t.holds(agentBox("ok"))).toBe(true);
    expect(t.holds(projectBox("p-ok"))).toBe(true);
    for (const id of ["paused", "quarantined", "broken", "theirs"]) expect(t.holds(agentBox(id))).toBe(false);
    for (const id of ["p-deleting", "p-off"]) expect(t.holds(projectBox(id))).toBe(false);
  });

  it("pausing an always-on agent re-arms the idle stop of its VM once", () => {
    const t = bed({ agents: { o1: [agent("a", { threadSessionId: "s1" })] } });
    const a = t.agents.o1?.[0];
    if (a) a.paused = true;
    t.change("o1", "a");
    expect(t.refreshIdle).toHaveBeenCalledTimes(1);
    expect(t.refreshIdle).toHaveBeenCalledWith({ kind: "agent", id: "a" });
    expect(t.touchIdle).toHaveBeenCalledWith("o1", "s1");
    t.change("o1", "a");
    expect(t.refreshIdle).toHaveBeenCalledTimes(1);
  });

  it("turning the switch off re-arms the idle stop and the thread's idle wait", () => {
    const t = bed({ agents: { o1: [agent("a", { threadSessionId: "s1" })] } });
    const a = t.agents.o1?.[0];
    if (a) a.alwaysOn = false;
    t.change("o1", "a");
    expect(t.refreshIdle).toHaveBeenCalledWith({ kind: "agent", id: "a" });
    expect(t.touchIdle).toHaveBeenCalledWith("o1", "s1");
  });

  it("an edit of a plain agent re-arms nothing", () => {
    const t = bed({ agents: { o1: [agent("a", { alwaysOn: false })] } });
    t.change("o1", "a");
    expect(t.refreshIdle).not.toHaveBeenCalled();
  });
});
