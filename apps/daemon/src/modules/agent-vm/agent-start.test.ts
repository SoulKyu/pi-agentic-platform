import { type AgentInput, DEFAULT_AGENT_RESOURCES, PapError } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { type AgentStartDeps, createAgentStart } from "./agent-start.ts";

const OWNER = "owner-1";
const AGENT = "scout-0001";
const IMAGE = "pap-agent-test";
const INPUT = { resources: DEFAULT_AGENT_RESOURCES } as unknown as AgentInput;

function bed(over: Partial<AgentStartDeps> = {}) {
  const log: string[] = [];
  const ends: Array<[boolean, string | undefined]> = [];
  let phase: "running" | "stopped" = "stopped";
  const started: unknown[] = [];
  let release: () => void = () => {};
  let hold: Promise<void> | null = null;
  const open = vi.fn(() => {
    log.push("open");
    return {
      id: "l1",
      step: (step: string, state: string) => void log.push(`${step}:${state}`),
      wait: () => {},
      stopped: () => false,
      end: (ok: boolean, code?: string) => void ends.push([ok, code]),
    };
  });
  const deps: AgentStartDeps = {
    runtime: {
      // As the real runtime: `phase()` falls back to an isolated task VM (`task`), the link is the thread VM's alone.
      link: () => (phase === "running" ? ({} as never) : undefined),
      start: vi.fn(async (spec) => {
        started.push(spec);
        await hold;
        phase = "running";
      }),
    },
    launches: { open } as never,
    gate: vi.fn(async () => {}),
    imageTagOf: vi.fn(() => IMAGE),
    agentOf: () => ({ input: INPUT, paused: false, quarantined: false }),
    recheck: vi.fn(),
    disabled: () => false,
    ...over,
  };
  return {
    start: createAgentStart(deps),
    deps,
    open,
    log,
    ends,
    started,
    setPhase: (next: "running" | "stopped") => void (phase = next),
    hold() {
      hold = new Promise<void>((resolve) => (release = resolve));
    },
    release: () => release(),
  };
}

const codeOf = async (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "ok",
    (error: unknown) => (error instanceof PapError ? error.code : "other"),
  );

describe("createAgentStart", () => {
  it("leaves a running VM alone: no launch, no start", async () => {
    const b = bed();
    b.setPhase("running");
    await b.start(OWNER, AGENT);
    expect(b.open).not.toHaveBeenCalled();
    expect(b.deps.runtime.start).not.toHaveBeenCalled();
  });

  it("starts the thread VM while only an isolated task VM of the agent runs", async () => {
    // Only a task VM runs: the runtime has no thread link, whatever its `phase()` says for the box.
    const b = bed();
    await b.start(OWNER, AGENT);
    expect(b.deps.runtime.start).toHaveBeenCalledTimes(1);
  });

  it("refuses an account disabled while the image was awaited, and starts nothing", async () => {
    let off = false;
    const b = bed({
      disabled: () => off,
      imageTagOf: vi.fn(() => {
        off = true;
        return IMAGE;
      }),
    });
    expect(await codeOf(b.start(OWNER, AGENT))).toBe("account_disabled");
    expect(b.ends).toEqual([[false, "account_disabled"]]);
    expect(b.deps.runtime.start).not.toHaveBeenCalled();
  });

  it("starts a stopped VM: one launch, the steps in order, the thread spec", async () => {
    const b = bed();
    await b.start(OWNER, AGENT);
    expect(b.open).toHaveBeenCalledExactlyOnceWith({
      box: { kind: "agent", id: AGENT },
      owner: OWNER,
      for: "start",
    });
    expect(b.log).toEqual(["open", "checks:running", "checks:done", "image:running", "image:done"]);
    expect(b.deps.recheck).toHaveBeenCalledWith(OWNER, AGENT);
    expect(b.started).toEqual([
      expect.objectContaining({
        box: { kind: "agent", id: AGENT },
        kind: "thread",
        taskKey: null,
        image: IMAGE,
        resources: DEFAULT_AGENT_RESOURCES,
      }),
    ]);
    expect(b.ends).toEqual([[true, undefined]]);
  });

  it.each([
    ["unknown", () => null, "not_found"],
    ["paused", () => ({ input: INPUT, paused: true, quarantined: false }), "agent_paused"],
    ["quarantined", () => ({ input: INPUT, paused: false, quarantined: true }), "agent_paused"],
  ])("refuses an agent that is %s with no launch", async (_name, agentOf, code) => {
    const b = bed({ agentOf });
    expect(await codeOf(b.start(OWNER, AGENT))).toBe(code);
    expect(b.open).not.toHaveBeenCalled();
    expect(b.deps.runtime.start).not.toHaveBeenCalled();
  });

  it("refuses a paused agent even when its VM runs", async () => {
    const b = bed({ agentOf: () => ({ input: INPUT, paused: true, quarantined: false }) });
    b.setPhase("running");
    expect(await codeOf(b.start(OWNER, AGENT))).toBe("agent_paused");
  });

  it("ends the launch with the code of a gate refusal, and starts nothing", async () => {
    const b = bed({
      gate: async () => {
        throw new PapError("vm_bundle_stale");
      },
    });
    expect(await codeOf(b.start(OWNER, AGENT))).toBe("vm_bundle_stale");
    expect(b.ends).toEqual([[false, "vm_bundle_stale"]]);
    expect(b.deps.runtime.start).not.toHaveBeenCalled();
  });

  it("ends the launch when the recheck refuses after the image wait", async () => {
    const b = bed({
      recheck: () => {
        throw new PapError("agent_paused");
      },
    });
    expect(await codeOf(b.start(OWNER, AGENT))).toBe("agent_paused");
    expect(b.ends).toEqual([[false, "agent_paused"]]);
    expect(b.deps.runtime.start).not.toHaveBeenCalled();
  });

  it("shares one start between two concurrent calls, and starts again once it is over", async () => {
    const b = bed();
    b.hold();
    const first = b.start(OWNER, AGENT);
    const second = b.start(OWNER, AGENT);
    await vi.waitFor(() => expect(b.deps.runtime.start).toHaveBeenCalledTimes(1), { timeout: 2000 });
    b.release();
    await Promise.all([first, second]);
    expect(b.open).toHaveBeenCalledTimes(1);
    expect(b.deps.runtime.start).toHaveBeenCalledTimes(1);
    b.setPhase("stopped");
    await b.start(OWNER, AGENT);
    expect(b.deps.runtime.start).toHaveBeenCalledTimes(2);
  });

  it("forgets a failed start: the next call tries again", async () => {
    let fail = true;
    const b = bed({
      gate: async () => {
        if (fail) throw new PapError("sandbox_unavailable");
      },
    });
    expect(await codeOf(b.start(OWNER, AGENT))).toBe("sandbox_unavailable");
    fail = false;
    await b.start(OWNER, AGENT);
    expect(b.ends).toEqual([
      [false, "sandbox_unavailable"],
      [true, undefined],
    ]);
  });
});
