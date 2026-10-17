import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunEndEvent } from "../runs/index.ts";
import { agentInput, createAgentsBed, type AgentsBed } from "./testing/bed.ts";
import { bedHelpers } from "./testing/helpers.ts";
import { createUnread } from "./unread.ts";

let bed: AgentsBed;
afterEach(() => bed.dispose());
const { refusalOf } = bedHelpers(() => bed);

async function setup(extra: Partial<Parameters<typeof createUnread>[0]> = {}) {
  bed = createAgentsBed();
  const { id } = await bed.agents.create(bed.owner(), agentInput());
  bed.db.run("UPDATE agents SET thread_session_id = 't1'");
  const listeners: Array<(event: RunEndEvent) => void> = [];
  const changed = vi.fn();
  const unread = createUnread({
    store: bed.agents.store,
    clock: bed.clock,
    runs: { onRunEnd: (listener) => (listeners.push(listener), () => void listeners.splice(0)) },
    changed,
    ...extra,
  });
  let runs = 0;
  const end = (sessionId: string, status: RunEndEvent["status"], ownerId = "u1", runId = `r${++runs}`) =>
    listeners.forEach((listener) =>
      listener({
        runId,
        sessionId,
        ownerId,
        taskId: null,
        origin: "user",
        status,
        costUsd: 0,
        errorClass: null,
        limitResetAt: null,
      }),
    );
  const count = () =>
    bed.db.get<{ unread: number; read_at: number | null }>(
      "SELECT unread, read_at FROM agents WHERE id = $id",
      {
        id,
      },
    );
  return { id, unread, end, count, changed, listeners };
}

describe("unread (M11R61)", () => {
  it("counts a completed run of the thread, and only that", async () => {
    const { id, end, count, changed } = await setup();
    end("t1", "completed");
    expect(count()?.unread).toBe(1);
    expect(changed).toHaveBeenCalledWith("u1", id);
    end("t1", "failed");
    end("t1", "cancelled");
    end("t1", "limited");
    end("other", "completed");
    end("t1", "completed", "u2");
    expect(count()?.unread).toBe(1);
    end("t1", "completed");
    expect(count()?.unread).toBe(2);
  });

  it("counts the same run end once, however often it is fed", async () => {
    const { end, count, changed } = await setup();
    end("t1", "completed", "u1", "same");
    end("t1", "completed", "u1", "same");
    expect(count()?.unread).toBe(1);
    expect(changed).toHaveBeenCalledTimes(1);
    end("t1", "completed", "u1", "next");
    expect(count()?.unread).toBe(2);
  });

  it("forgets the oldest counted run id past 256, and keeps exactly 256", async () => {
    const { end, count } = await setup();
    for (let n = 0; n < 257; n += 1) end("t1", "completed", "u1", `run-${n}`);
    expect(count()?.unread).toBe(257);
    // run-0 was forgotten (counted again); run-1 is still remembered (not counted).
    end("t1", "completed", "u1", "run-1");
    expect(count()?.unread).toBe(257);
    end("t1", "completed", "u1", "run-0");
    expect(count()?.unread).toBe(258);
    // Remembering run-0 again evicted run-1 and nothing more: 256 are held.
    end("t1", "completed", "u1", "run-257");
    expect(count()?.unread).toBe(259);
    end("t1", "completed", "u1", "run-200");
    expect(count()?.unread).toBe(259);
  });

  it("stops at the column's cap instead of failing the run's end", async () => {
    const { end, count } = await setup();
    bed.db.run("UPDATE agents SET unread = 1000000");
    end("t1", "completed");
    expect(count()?.unread).toBe(1_000_000);
  });

  it("adds one per event card through bump", async () => {
    const { id, unread, count } = await setup();
    unread.bump("u1", id);
    unread.bump("u1", id);
    unread.bump("u2", id);
    expect(count()?.unread).toBe(2);
  });

  it("markRead sets the count to 0 with the time, and is not_found for another owner's agent", async () => {
    const { id, unread, count, changed } = await setup();
    unread.bump("u1", id);
    await bed.clock.advance(5);
    unread.markRead("u1", id);
    expect(count()).toEqual({ unread: 0, read_at: bed.clock.now() });
    expect(changed).toHaveBeenLastCalledWith("u1", id);
    expect(await refusalOf(() => unread.markRead("u2", id))).toBe("not_found");
  });

  it("stop ends the listening", async () => {
    const { unread, listeners } = await setup();
    unread.stop();
    expect(listeners).toHaveLength(0);
  });
});

describe("the agent_reply Inbox item (M11R91)", () => {
  const reply = () => {
    const calls: string[] = [];
    return {
      calls,
      port: {
        raise: (owner: string, agent: string) => void calls.push(`raise ${owner} ${agent}`),
        clear: (owner: string, agent: string) => void calls.push(`clear ${owner} ${agent}`),
      },
    };
  };

  it("is raised when the count rises and closed when the owner reads the thread", async () => {
    const { calls, port } = reply();
    const { id, end, unread } = await setup({ reply: port });
    end("t1", "completed");
    unread.bump("u1", id);
    unread.markRead("u1", id);
    expect(calls).toEqual([`raise u1 ${id}`, `raise u1 ${id}`, `clear u1 ${id}`]);
  });

  it("raises nothing when the count did not rise (another owner, a failed run)", async () => {
    const { calls, port } = reply();
    const { id, end, unread } = await setup({ reply: port });
    end("t1", "failed");
    unread.bump("u2", id);
    expect(calls).toEqual([]);
  });

  it("logs a failing Inbox write and still counts and marks read", async () => {
    const warn = vi.fn();
    const failing = {
      raise: () => {
        throw new Error("inbox down");
      },
      clear: () => {
        throw new Error("inbox down");
      },
    };
    const { id, unread, count } = await setup({ reply: failing, logger: { warn } });
    unread.bump("u1", id);
    expect(count()?.unread).toBe(1);
    unread.markRead("u1", id);
    expect(count()?.unread).toBe(0);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
