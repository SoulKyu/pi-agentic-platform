import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import type { HealthEvents } from "../health/index.ts";
import type { AgentLinks } from "./links.ts";
import { agentInput, createAgentsBed, type AgentsBed } from "./testing/bed.ts";
import { bedHelpers } from "./testing/helpers.ts";
import { fakeSessions, QUIET } from "./testing/thread-bed.ts";
import { createThreads } from "./threads.ts";

let bed: AgentsBed;
afterEach(() => bed.dispose());
const { refusalOf } = bedHelpers(() => bed);

async function setup(links: AgentLinks = {}, health?: Pick<HealthEvents, "emit">) {
  bed = createAgentsBed();
  const { id } = await bed.agents.create(bed.owner(), agentInput());
  const sessions = fakeSessions();
  const changed = vi.fn();
  const threads = createThreads({
    store: bed.agents.store,
    sessions: sessions.port,
    guard: bed.guard,
    clock: bed.clock,
    logger: silentLogger,
    links: () => links,
    changed,
    audit: bed.audit,
    health,
  });
  const row = () =>
    bed.db.get<{ thread_session_id: string | null; unread: number; read_at: number | null }>(
      "SELECT thread_session_id, unread, read_at FROM agents WHERE id = $id",
      { id },
    );
  return { id, sessions, changed, threads, row };
}

describe("openThread (M11R59)", () => {
  it("two opens at once start one thread and both get its id", async () => {
    const { id, sessions, threads, row } = await setup();
    sessions.gate.hold = true;
    const first = threads.open("u1", id);
    const second = threads.open("u1", id);
    await vi.waitFor(() => expect(sessions.gate.release).not.toBeNull(), { timeout: 2000 });
    sessions.gate.hold = false;
    sessions.gate.release?.();
    expect(await Promise.all([first, second])).toEqual([{ sessionId: "t1" }, { sessionId: "t1" }]);
    expect(sessions.createAgentSession).toHaveBeenCalledTimes(1);
    expect(sessions.createAgentSession).toHaveBeenCalledWith({ ownerId: "u1", agentId: id, role: "thread" });
    expect(row()?.thread_session_id).toBe("t1");
  });

  it("returns the thread it has, without starting anything", async () => {
    const { id, sessions, threads } = await setup();
    await threads.open("u1", id);
    expect(await threads.open("u1", id)).toEqual({ sessionId: "t1" });
    expect(sessions.createAgentSession).toHaveBeenCalledTimes(1);
  });

  it("starts a new thread when the old one is archived or gone, and clears the old one's unread count", async () => {
    const { id, sessions, threads, row } = await setup();
    await threads.open("u1", id);
    bed.db.run("UPDATE agents SET unread = 4");
    sessions.states.set("t1", { ...QUIET, archived: true });
    expect(await threads.open("u1", id)).toEqual({ sessionId: "t2" });
    expect(row()).toMatchObject({ thread_session_id: "t2", unread: 0 });
    sessions.states.delete("t2");
    expect(await threads.open("u1", id)).toEqual({ sessionId: "t3" });
  });

  it("refuses a quarantined agent with agent_paused and opens a paused one", async () => {
    const { id, sessions, threads } = await setup();
    bed.agents.setPaused("u1", id, true);
    expect(await threads.open("u1", id)).toEqual({ sessionId: "t1" });
    bed.db.run("UPDATE agents SET quarantined_at = 1, paused = 1");
    bed.db.run("UPDATE agents SET thread_session_id = NULL");
    expect(await refusalOf(() => threads.open("u1", id))).toBe("agent_paused");
    expect(sessions.createAgentSession).toHaveBeenCalledTimes(1);
  });

  it("emits an agent health event when the launch is refused", async () => {
    const health = { emit: vi.fn() };
    const { id, sessions, threads } = await setup({}, health);
    bed.db.run("UPDATE agents SET quarantined_at = 1, paused = 1");
    expect(await refusalOf(() => threads.open("u1", id))).toBe("agent_paused");
    expect(sessions.createAgentSession).not.toHaveBeenCalled();
    expect(health.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent", code: "agent_paused" }),
    );
  });

  it("is not_found for an agent that is not the owner's, and refuses while a delete is in flight", async () => {
    const { id, sessions, threads } = await setup();
    expect(await refusalOf(() => threads.open("u2", id))).toBe("not_found");
    bed.guard.deleting.add(id);
    expect(await refusalOf(() => threads.open("u1", id))).toBe("session_busy");
    expect(sessions.createAgentSession).not.toHaveBeenCalled();
  });

  it("a refused start leaves no thread and does not block the next open", async () => {
    const { id, sessions, threads, row } = await setup();
    sessions.gate.failWith = "capacity";
    expect(await refusalOf(() => threads.open("u1", id))).toBe("capacity");
    expect(row()?.thread_session_id).toBeNull();
    expect(bed.guard.opening.has(id)).toBe(false);
    sessions.gate.failWith = null;
    expect(await threads.open("u1", id)).toEqual({ sessionId: "t1" });
  });

  it("marks the agent as opening while the thread starts, and tells the rail when it is set", async () => {
    const { id, sessions, changed, threads } = await setup();
    sessions.gate.hold = true;
    const opening = threads.open("u1", id);
    await vi.waitFor(() => expect(bed.guard.opening.has(id)).toBe(true), { timeout: 2000 });
    sessions.gate.hold = false;
    sessions.gate.release?.();
    await opening;
    expect(bed.guard.opening.has(id)).toBe(false);
    expect(changed).toHaveBeenCalledWith("u1", id);
  });

  it("discards a session the row no longer wants (the thread changed under the call)", async () => {
    const links: AgentLinks = {
      threads: { busy: () => false, archive: vi.fn(), releaseIdle: vi.fn() },
    };
    const { id, sessions, threads } = await setup(links);
    sessions.gate.hold = true;
    const opening = threads.open("u1", id);
    await vi.waitFor(() => expect(sessions.gate.release).not.toBeNull(), { timeout: 2000 });
    bed.db.run("UPDATE agents SET thread_session_id = 'other'");
    sessions.gate.hold = false;
    sessions.gate.release?.();
    expect(await refusalOf(() => opening)).toBe("conflict");
    expect(links.threads?.archive).toHaveBeenCalledWith("u1", "t1");
    expect(links.threads?.releaseIdle).toHaveBeenCalledWith("u1", "t1");
  });
});

describe("resetThread (M11R60)", () => {
  const withThread = (extra: Partial<NonNullable<AgentLinks["threads"]>> = {}, inbox = vi.fn()) => {
    const threads = { busy: () => false, archive: vi.fn(), releaseIdle: vi.fn(), ...extra };
    return {
      threads,
      inbox,
      links: { threads, inbox: { clearReply: inbox, removeAgentItems: vi.fn() } } satisfies AgentLinks,
    };
  };

  it("is refused while the thread runs, starts or waits for an answer, and changes nothing", async () => {
    const kit = withThread();
    const { id, sessions, threads, row } = await setup(kit.links);
    await threads.open("u1", id);
    bed.db.run("UPDATE agents SET unread = 3");
    for (const state of [{ running: true }, { starting: true }, { needsInput: true }]) {
      sessions.states.set("t1", { ...QUIET, ...state });
      expect(await refusalOf(() => threads.reset(bed.owner(), id))).toBe("session_busy");
    }
    expect(row()).toMatchObject({ thread_session_id: "t1", unread: 3 });
    expect(kit.threads.archive).not.toHaveBeenCalled();
    expect(kit.inbox).not.toHaveBeenCalled();
  });

  it("is refused while a prompt is pending on the thread (the sessions module's own busy answer)", async () => {
    const kit = withThread({ busy: () => true });
    const { id, threads, row } = await setup(kit.links);
    await threads.open("u1", id);
    expect(await refusalOf(() => threads.reset(bed.owner(), id))).toBe("session_busy");
    expect(row()?.thread_session_id).toBe("t1");
  });

  it("archives the thread, lets its worker go, clears the thread id, the unread count and the reply item", async () => {
    const kit = withThread();
    const { id, threads, row, changed } = await setup(kit.links);
    await threads.open("u1", id);
    bed.db.run("UPDATE agents SET unread = 5");
    await threads.reset(bed.owner(), id);
    expect(kit.threads.archive).toHaveBeenCalledWith("u1", "t1");
    expect(kit.threads.releaseIdle).toHaveBeenCalledWith("u1", "t1");
    expect(kit.inbox).toHaveBeenCalledWith("u1", id);
    expect(row()).toEqual({ thread_session_id: null, unread: 0, read_at: bed.clock.now() });
    expect(changed).toHaveBeenLastCalledWith("u1", id);
    expect(bed.auditRows().at(-1)).toMatchObject({ reason: "agent thread reset", kind: "policy" });
    // The profile stays and the next open starts a new thread.
    expect(bed.agents.port.get("u1", id)?.input?.name).toBe("Atlas");
    expect(await threads.open("u1", id)).toEqual({ sessionId: "t2" });
  });

  it("resets an agent that has no thread, and is not_found for another owner's agent", async () => {
    const kit = withThread();
    const { id, threads } = await setup(kit.links);
    await threads.reset(bed.owner(), id);
    expect(kit.threads.archive).not.toHaveBeenCalled();
    expect(await refusalOf(() => threads.reset(bed.owner({ userId: "u2" }), id))).toBe("not_found");
  });

  it("is refused while the thread is being opened or the agent deleted", async () => {
    const { id, threads } = await setup();
    bed.guard.opening.add(id);
    expect(await refusalOf(() => threads.reset(bed.owner(), id))).toBe("session_busy");
    bed.guard.opening.delete(id);
    bed.guard.deleting.add(id);
    expect(await refusalOf(() => threads.reset(bed.owner(), id))).toBe("session_busy");
  });

  it("a failing reply-item link is logged and does not undo the reset", async () => {
    const kit = withThread(
      {},
      vi.fn(() => {
        throw new Error("boom");
      }),
    );
    const { id, threads, row } = await setup(kit.links);
    await threads.open("u1", id);
    await threads.reset(bed.owner(), id);
    expect(row()?.thread_session_id).toBeNull();
  });

  it("forgets the agent's waiting one-use values (their session is archived)", async () => {
    const drop = vi.fn();
    const kit = withThread();
    const { id, threads, row } = await setup({ ...kit.links, onceValues: { drop } });
    await threads.open("u1", id);
    await threads.reset(bed.owner(), id);
    expect(drop).toHaveBeenCalledExactlyOnceWith("u1", id);
    expect(row()?.thread_session_id).toBeNull();
  });

  it("a failing one-use link is logged and does not undo the reset", async () => {
    const kit = withThread();
    const onceValues = {
      drop: () => {
        throw new Error("boom");
      },
    };
    const { id, threads, row } = await setup({ ...kit.links, onceValues });
    await threads.open("u1", id);
    await threads.reset(bed.owner(), id);
    expect(row()?.thread_session_id).toBeNull();
  });
});
