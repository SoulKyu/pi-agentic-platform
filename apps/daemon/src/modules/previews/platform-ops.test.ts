import { type ApprovalMode, type BoxRef, PapError, type ServiceView, type SessionType } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { type PlatformContext, PlatformRefusal } from "../platform/index.ts";
import { createPreviewStart, createPreviewStop, type PreviewOpDeps } from "./platform-ops.ts";
import type { ServiceSpec } from "./registry.ts";

const PROJECT = "0b1c2d3e-0000-4000-8000-000000000001";
const VIEW: ServiceView = {
  id: "a".repeat(32),
  name: "site",
  port: 3000,
  state: "running",
  reason: null,
  startedAt: 1,
  network: false,
};
const ARGS = { name: "site", command: "serve .", port: 3000 };

const ctx = (type: SessionType, extra: Partial<PlatformContext> = {}): PlatformContext => ({
  ownerId: "u1",
  sessionId: "s1",
  type,
  tainted: false,
  agentId: type === "agent-thread" ? "atlas-0001" : null,
  signal: new AbortController().signal,
  ...extra,
});

function bed(
  over: {
    projectOf?: string | null;
    shellNetwork?: boolean | null;
    mode?: ApprovalMode | null;
    start?: (spec: { network: boolean }) => Promise<ServiceView>;
    stop?: () => Promise<boolean>;
  } = {},
) {
  const started: Array<{ box: BoxRef; owner: string; spec: ServiceSpec }> = [];
  const stopped: Array<{ box: BoxRef; name: string }> = [];
  const seen: Array<[string, string]> = [];
  const deps: PreviewOpDeps = {
    registry: {
      start: async (box, owner, spec) => {
        started.push({ box, owner, spec });
        return over.start ? over.start(spec) : { ...VIEW, network: spec.network };
      },
      stop: async (box, name) => {
        stopped.push({ box, name });
        return over.stop ? over.stop() : true;
      },
    },
    projectOf: () => (over.projectOf === undefined ? PROJECT : over.projectOf),
    shellNetwork: (owner, session) => {
      seen.push([owner, session]);
      return over.shellNetwork === undefined ? false : over.shellNetwork;
    },
    modeNow: () => (over.mode === undefined ? "full-access" : over.mode),
  };
  return { deps, started, stopped, seen, start: createPreviewStart(deps), stop: createPreviewStop(deps) };
}

const code = async (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => "ok",
    (error: unknown) => (error instanceof PlatformRefusal ? error.code : `thrown:${String(error)}`),
  );

describe("preview.start", () => {
  it("an agent with sandbox.network off starts its service with network false, whatever the call says", async () => {
    const b = bed({ shellNetwork: false });
    await b.start({ ...ARGS, network: true } as never, ctx("agent-thread"));
    expect(b.started).toHaveLength(1);
    expect(b.started[0]).toMatchObject({
      box: { kind: "agent", id: "atlas-0001" },
      owner: "u1",
      spec: { name: "site", command: "serve .", port: 3000, network: false },
    });
    expect(b.seen).toEqual([["u1", "s1"]]);
  });

  it("an agent whose shell has network starts its service with network true", async () => {
    const b = bed({ shellNetwork: true });
    await b.start(ARGS, ctx("agent-thread"));
    expect(b.started[0]?.spec).toMatchObject({ network: true });
  });

  it("no start-time profile: forbidden, nothing started", async () => {
    const b = bed({ shellNetwork: null });
    expect(await code(b.start(ARGS, ctx("agent-thread")))).toBe("forbidden");
    expect(b.started).toEqual([]);
  });

  it("a read-only session's preview.start is forbidden whatever the worker says (plain and agent thread)", async () => {
    for (const type of ["plain", "agent-thread"] as const) {
      const b = bed({ mode: "read-only", shellNetwork: true });
      expect(await code(b.start(ARGS, ctx(type)))).toBe("forbidden");
      expect(b.started).toEqual([]);
    }
  });

  it("a mode the daemon cannot read is forbidden, every other mode runs", async () => {
    expect(await code(bed({ mode: null }).start(ARGS, ctx("plain")))).toBe("forbidden");
    for (const mode of ["supervised", "auto-accept-edits", "full-access"] as const)
      expect(await code(bed({ mode }).start(ARGS, ctx("plain")))).toBe("ok");
  });

  it("a box's plain session starts with network true, in its project box", async () => {
    const b = bed();
    await b.start(ARGS, ctx("plain"));
    expect(b.started[0]).toMatchObject({ box: { kind: "project", id: PROJECT }, spec: { network: true } });
    expect(b.seen).toEqual([]);
  });

  it("a host plain session is forbidden", async () => {
    const b = bed({ projectOf: null });
    expect(await code(b.start(ARGS, ctx("plain")))).toBe("forbidden");
    expect(b.started).toEqual([]);
  });

  it("any other session type is forbidden", async () => {
    for (const type of ["lane", "task", "agent-task", "child"] as const) {
      const b = bed();
      expect(await code(b.start(ARGS, ctx(type)))).toBe("forbidden");
      expect(b.started).toEqual([]);
    }
  });

  it("an agent thread whose context names no agent is forbidden", async () => {
    const b = bed();
    expect(await code(b.start(ARGS, ctx("agent-thread", { agentId: null })))).toBe("forbidden");
  });

  it("the guest's refusals map: box_stopped is unavailable, limit_reached, timeout and bad_request stay", async () => {
    const table: Array<[PapError, string]> = [
      [new PapError("box_stopped"), "unavailable"],
      [new PapError("limit_reached"), "limit_reached"],
      [new PapError("timeout"), "timeout"],
      [new PapError("bad_request"), "bad_request"],
    ];
    for (const [error, expected] of table) {
      const b = bed({ start: () => Promise.reject(error) });
      expect(await code(b.start(ARGS, ctx("plain")))).toBe(expected);
    }
  });

  it("any other failure is rethrown as it is, for the dispatcher to log and answer internal", async () => {
    for (const error of [new PapError("worker_failed"), new PapError("not_found"), new Error("x")]) {
      const b = bed({ start: () => Promise.reject(error) });
      await expect(b.start(ARGS, ctx("plain"))).rejects.toBe(error);
    }
  });

  it("the answer carries id, name, port, status and reason, never output", async () => {
    const running = await bed().start(ARGS, ctx("plain"));
    expect(running).toEqual({ id: VIEW.id, name: "site", port: 3000, status: "running", reason: null });
    const failed = await bed({
      start: async () => ({ ...VIEW, state: "failed", reason: "port_timeout" }),
    }).start(ARGS, ctx("plain"));
    expect(failed).toEqual({
      id: VIEW.id,
      name: "site",
      port: 3000,
      status: "failed",
      reason: "port_timeout",
    });
    const stopped = await bed({ start: async () => ({ ...VIEW, state: "stopped" }) }).start(
      ARGS,
      ctx("plain"),
    );
    expect(stopped.status).toBe("failed");
  });

  it("the call's own signal reaches the registry", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const b = bed();
    b.deps.registry.start = async (_box, _owner, _spec, signal) => {
      received = signal;
      return VIEW;
    };
    await createPreviewStart(b.deps)(ARGS, ctx("plain", { signal: controller.signal }));
    expect(received).toBe(controller.signal);
  });
});

describe("preview.stop", () => {
  it("stops in the caller's own box: an agent's, or the project's", async () => {
    const agent = bed();
    expect(await agent.stop({ name: "site" }, ctx("agent-thread"))).toEqual({ stopped: true });
    expect(agent.stopped).toEqual([{ box: { kind: "agent", id: "atlas-0001" }, name: "site" }]);
    const plain = bed();
    await plain.stop({ name: "site" }, ctx("plain"));
    expect(plain.stopped).toEqual([{ box: { kind: "project", id: PROJECT }, name: "site" }]);
  });

  it("is not refused in read-only (it runs nothing) and needs no start-time network", async () => {
    const b = bed({ mode: "read-only", shellNetwork: null });
    expect(await code(b.stop({ name: "site" }, ctx("agent-thread")))).toBe("ok");
    expect(b.seen).toEqual([]);
  });

  it("a host plain session and any other type are forbidden", async () => {
    expect(await code(bed({ projectOf: null }).stop({ name: "site" }, ctx("plain")))).toBe("forbidden");
    for (const type of ["lane", "task", "agent-task", "child"] as const)
      expect(await code(bed().stop({ name: "site" }, ctx(type)))).toBe("forbidden");
  });

  it("box_stopped answers unavailable, a stop of nothing answers stopped false", async () => {
    expect(
      await code(
        bed({ stop: () => Promise.reject(new PapError("box_stopped")) }).stop({ name: "x" }, ctx("plain")),
      ),
    ).toBe("unavailable");
    expect(await bed({ stop: async () => false }).stop({ name: "x" }, ctx("plain"))).toEqual({
      stopped: false,
    });
  });
});
