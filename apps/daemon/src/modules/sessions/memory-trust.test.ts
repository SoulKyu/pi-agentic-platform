import type { SessionStreamEvent, SessionType } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import type { LiveSession } from "./live-types.ts";
import { createMemoryRelease, type MemoryTrustDecision, memoryTrustOf } from "./memory-trust.ts";

const launchOf = (memory: object | null = null) =>
  ({ agent: { id: "atlas-1a2b", name: "Atlas", role: "" }, input: { memory } }) as never;
const CLOSED = { memory: { profile: "", trust: "untrusted" }, env: { PI_MEM0_CAPTURE: "0" } };

describe("memoryTrustOf (M11R142)", () => {
  it("an untainted agent thread is trusted, with its policy", () => {
    expect(
      memoryTrustOf({ type: "agent-thread", tainted: false }, launchOf({ capture: "off", save: "staged" })),
    ).toEqual({
      memory: { profile: "atlas-1a2b", trust: "trusted", memory: { capture: "off", save: "staged" } },
      env: {},
    });
  });

  it("an untainted agent thread without a policy writes none", () => {
    const { memory } = memoryTrustOf({ type: "agent-thread", tainted: false }, launchOf(null));
    expect(memory).toEqual({ profile: "atlas-1a2b", trust: "trusted" });
    expect(memory).not.toHaveProperty("memory");
  });

  it("a tainted agent thread and an agent task are untrusted under their own profile, never trusted, no policy", () => {
    for (const [type, tainted] of [
      ["agent-thread", true],
      ["agent-task", false],
      ["agent-task", true],
    ] as const)
      expect(memoryTrustOf({ type, tainted }, launchOf({ capture: "auto" }))).toEqual({
        memory: { profile: "atlas-1a2b", trust: "untrusted" },
        env: {},
      });
  });

  it("a child, an M10 task session and any session tainted at start fail closed, with capture off in the environment", () => {
    for (const [type, tainted] of [
      ["child", false],
      ["child", true],
      ["task", false],
      ["task", true],
      ["plain", true],
      ["lane", true],
    ] as const)
      expect(memoryTrustOf({ type, tainted }, type === "child" ? launchOf() : null)).toEqual(CLOSED);
  });

  it("an untainted plain or lane session is left to pi-mem0's ordinary session: no entry, no environment", () => {
    for (const type of ["plain", "lane"] as const)
      expect(memoryTrustOf({ type, tainted: false }, null)).toEqual({ env: {} });
  });

  it("every session type is decided (no fall-through to trusted)", () => {
    const types: SessionType[] = ["plain", "lane", "task", "agent-thread", "agent-task", "child"];
    for (const type of types) {
      const decision = memoryTrustOf(
        { type, tainted: true },
        type.startsWith("agent") || type === "child" ? launchOf() : null,
      );
      expect(decision.memory?.trust).toBe("untrusted");
    }
  });
});

type Result = "released" | "busy" | "cold";
// What a worker was started with: no entry (plain), a trusted thread, or any closed / untrusted one.
const NONE: MemoryTrustDecision = { env: {} };
const TRUSTED: MemoryTrustDecision = { memory: { profile: "atlas-1a2b", trust: "trusted" }, env: {} };
const UNTRUSTED: MemoryTrustDecision = { memory: { profile: "atlas-1a2b", trust: "untrusted" }, env: {} };
const CLOSED_DECISION: MemoryTrustDecision = {
  memory: { profile: "", trust: "untrusted" },
  env: { PI_MEM0_CAPTURE: "0" },
};

function bed(releases: Result[] = ["released"]) {
  const listeners = new Set<(ownerId: string, sessionId: string) => void>();
  const tainted = new Set<string>();
  const release = vi.fn((): Result => releases.shift() ?? "released");
  const unlisten = vi.fn();
  const warn = vi.fn();
  const memory = createMemoryRelease({
    policy: {
      sessionPolicy: (_o: string, id: string) => ({ taint: { tainted: tainted.has(id), epoch: 0 } }) as never,
      onSessionChange: (listener) => {
        listeners.add(listener);
        return () => void unlisten(listeners.delete(listener));
      },
    },
    release,
    logger: { warn } as never,
  });
  const taint = (id: string) => {
    tainted.add(id);
    for (const listener of [...listeners]) listener("u1", id);
  };
  const status = (id: string, value: "idle" | "running") =>
    memory.published(id, { kind: "status", status: value } as SessionStreamEvent);
  return { memory, release, taint, status, unlisten, listeners, tainted, warn };
}
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("createMemoryRelease (M11R143)", () => {
  it("releases an idle worker that started untainted the moment its session is tainted", () => {
    const { memory, release, taint } = bed();
    memory.started("s1", NONE);
    taint("s1");
    expect(release).toHaveBeenCalledExactlyOnceWith("u1", "s1");
  });

  it("waits for the run to settle: busy now, released at the idle status", async () => {
    const { memory, release, taint, status } = bed(["busy", "released"]);
    memory.started("s1", TRUSTED);
    status("s1", "running");
    taint("s1");
    expect(release).toHaveBeenCalledTimes(1);
    status("s1", "idle");
    await flush();
    expect(release).toHaveBeenCalledTimes(2);
    status("s1", "idle");
    await flush();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("releases and watches only a worker that started with no entry or a trusted one (a reboot changes nothing for the others)", () => {
    const { memory, release, taint } = bed();
    memory.started("s1", UNTRUSTED);
    memory.started("s2", CLOSED_DECISION);
    memory.started("s3", NONE);
    taint("s1");
    taint("s2");
    expect(release).not.toHaveBeenCalled();
    taint("s3");
    expect(release).toHaveBeenCalledExactlyOnceWith("u1", "s3");
  });

  it("a change that is not a taint (the mode) releases nothing", () => {
    const { memory, release, listeners } = bed();
    memory.started("s1", NONE);
    for (const listener of listeners) listener("u1", "s1");
    expect(release).not.toHaveBeenCalled();
  });

  it("forgets a worker that ended, and stops listening on stop()", () => {
    const { memory, release, taint, unlisten } = bed();
    memory.started("s1", NONE);
    memory.ended("s1");
    taint("s1");
    expect(release).not.toHaveBeenCalled();
    memory.stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("a worker that started closed after a release is not released again", () => {
    const { memory, release, taint } = bed();
    memory.started("s1", NONE);
    taint("s1");
    memory.ended("s1");
    memory.started("s1", CLOSED_DECISION);
    taint("s1");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("logs a release it could not make yet, with the reason", () => {
    const { memory, taint, warn } = bed(["busy"]);
    memory.started("s1", NONE);
    taint("s1");
    expect(warn).toHaveBeenCalledExactlyOnceWith("memory_release_deferred", {
      sessionId: "s1",
      reason: "busy",
    });
  });

  it("a cold answer (the worker is not in `live` yet) keeps the release pending until the reopen settles", () => {
    const { memory, release, taint, warn } = bed(["cold", "released"]);
    memory.started("s1", NONE);
    taint("s1");
    expect(warn).toHaveBeenCalledWith("memory_release_deferred", { sessionId: "s1", reason: "cold" });
    memory.reopened("s1");
    expect(release).toHaveBeenCalledTimes(2);
    memory.reopened("s1");
    expect(release).toHaveBeenCalledTimes(2);
  });
});

describe("renew: the release is enforced at the next prompt (M11R143)", () => {
  const worker = (idle = true) => {
    const stop = vi.fn(() => Promise.resolve());
    return {
      stop,
      session: {
        status: () => (idle ? "idle" : "running"),
        busy: () => false,
        stop,
      } as unknown as LiveSession,
    };
  };

  it("hands out the same worker when no release is pending", async () => {
    const { memory } = bed();
    memory.started("s1", NONE);
    const { session, stop } = worker();
    const ensure = vi.fn();
    expect(memory.renew({ id: "s1" }, session, ensure)).toBeNull();
    expect(stop).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
  });

  it("stops a worker whose release is still pending (a dialog was open at settle) and gives the prompt a new one", async () => {
    const { memory, taint } = bed(["busy"]);
    memory.started("s1", NONE);
    taint("s1");
    const old = worker();
    const next = worker();
    const ensure = vi.fn(() => Promise.resolve(next.session));
    expect(await memory.renew({ id: "s1" }, old.session, ensure)).toBe(next.session);
    expect(old.stop).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledExactlyOnceWith({ id: "s1" });
  });

  it("a release that was only deferred while the worker booted (cold) is enforced too", async () => {
    const { memory, taint } = bed(["cold"]);
    memory.started("s1", NONE);
    taint("s1");
    const old = worker();
    const next = worker();
    expect(await memory.renew({ id: "s1" }, old.session, () => Promise.resolve(next.session))).toBe(
      next.session,
    );
    expect(old.stop).toHaveBeenCalledTimes(1);
  });

  it("never stops a worker that is running: a steering prompt joins its run", async () => {
    const { memory, taint } = bed(["busy"]);
    memory.started("s1", NONE);
    taint("s1");
    const running = worker(false);
    expect(memory.renew({ id: "s1" }, running.session, vi.fn())).toBeNull();
    expect(running.stop).not.toHaveBeenCalled();
  });

  it("asks for the new worker once: the pending release is consumed", async () => {
    const { memory, taint } = bed(["busy"]);
    memory.started("s1", NONE);
    taint("s1");
    const next = worker();
    await memory.renew({ id: "s1" }, worker().session, () => Promise.resolve(next.session));
    expect(memory.renew({ id: "s1" }, next.session, vi.fn())).toBeNull();
  });
});
