import { AutomationSettings, type PlatformError } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { PlatformContext } from "../platform/index.ts";
import { PlatformRefusal } from "../platform/index.ts";
import { afterQuietHours, createRemind, REMINDERS_PENDING, REMINDERS_PER_DAY } from "./ops-remind.ts";
import type { AgentTasksPort, ReminderRequest } from "./task-port.ts";

const ATLAS = "atlas-1a2b";
const DAY = 86_400_000;
const NOW = Date.parse("2026-10-16T08:00:00Z");

function setup(settings: Partial<AutomationSettings> = {}) {
  const clock = createFakeClock(NOW);
  const log: string[] = [];
  const state = {
    pending: 0,
    created: 0,
    over: false,
    requester: null as string | null,
    known: true,
  };
  const remind = vi.fn((request: ReminderRequest) => {
    log.push("remind");
    return { taskId: "task-1", extra: request.note };
  });
  const tasks: Pick<AgentTasksPort, "reminders" | "overBudget" | "runningRequester" | "remind"> = {
    reminders: (_owner, _agent, since) => (
      log.push(`count:${clock.now() - since}`),
      { pending: state.pending, created: state.created }
    ),
    overBudget: () => (log.push("budget"), state.over),
    runningRequester: () => (log.push("requester"), state.requester),
    remind,
  };
  const handler = createRemind({
    clock,
    agents: {
      get: (ownerId, id) => (state.known && ownerId === "u1" && id === ATLAS ? ({} as never) : null),
    },
    tasks,
    settings: { automation: () => AutomationSettings.parse(settings) },
  });
  const ctx = (over: Partial<PlatformContext> = {}): PlatformContext => ({
    ownerId: "u1",
    sessionId: "s1",
    type: "agent-thread",
    tainted: false,
    agentId: ATLAS,
    signal: new AbortController().signal,
    ...over,
  });
  const codeOf = async (when: string, over: Partial<PlatformContext> = {}, note = "Check the build") => {
    try {
      await handler({ when, note }, ctx(over));
      return "ok";
    } catch (error) {
      if (error instanceof PlatformRefusal) return error.code;
      throw error;
    }
  };
  return { clock, log, state, remind, handler, ctx, codeOf };
}

describe("agent.remind (M11R80)", () => {
  it("makes a thread task for the agent itself, not before the time asked, and answers its id and the time", async () => {
    const { handler, ctx, remind } = setup();
    const result = await handler({ when: "2h", note: "Check the build" }, ctx());
    expect(result).toEqual({ taskId: "task-1", at: NOW + 2 * 3_600_000 });
    expect(remind).toHaveBeenCalledWith({
      ownerId: "u1",
      agentId: ATLAS,
      note: "Check the build",
      notBefore: NOW + 2 * 3_600_000,
      requestedBy: null,
      tainted: false,
      sessionId: "s1",
    });
  });

  it("reads an ISO time with an offset", async () => {
    const { handler, ctx } = setup();
    expect(await handler({ when: "2026-10-16T12:00:00+02:00", note: "x" }, ctx())).toMatchObject({
      at: Date.parse("2026-10-16T10:00:00Z"),
    });
  });

  it.each(["9am", "tomorrow", "2026-10-16T12:00:00", "10s", "14m", "31d", "in 2 hours"])(
    "refuses %j as bad_request and counts nothing",
    async (when) => {
      const { codeOf, log } = setup();
      expect(await codeOf(when)).toBe("bad_request" satisfies PlatformError);
      expect(log).toEqual([]);
    },
  );

  it("answers not_found for a caller that is no agent of the owner", async () => {
    const world = setup();
    expect(await world.codeOf("2h", { agentId: null })).toBe("not_found");
    expect(await world.codeOf("2h", { ownerId: "u2" })).toBe("not_found");
    world.state.known = false;
    expect(await world.codeOf("2h")).toBe("not_found");
    expect(world.remind).not.toHaveBeenCalled();
  });

  it("allows 5 pending and answers limit_reached for the sixth", async () => {
    const { codeOf, state } = setup();
    state.pending = REMINDERS_PENDING - 1;
    expect(await codeOf("2h")).toBe("ok");
    state.pending = REMINDERS_PENDING;
    expect(await codeOf("2h")).toBe("limit_reached");
    expect(REMINDERS_PENDING).toBe(5);
  });

  it("allows 24 in a rolling 24 hours and answers rate_limited for the 25th", async () => {
    const { codeOf, state, log } = setup();
    state.created = REMINDERS_PER_DAY - 1;
    expect(await codeOf("2h")).toBe("ok");
    state.created = REMINDERS_PER_DAY;
    log.length = 0;
    expect(await codeOf("2h")).toBe("rate_limited");
    expect(log).toEqual([`count:${DAY}`]);
    expect(REMINDERS_PER_DAY).toBe(24);
  });

  it("answers budget when the agent is over its line at creation", async () => {
    const { codeOf, state, remind } = setup();
    state.over = true;
    expect(await codeOf("2h")).toBe("budget");
    expect(remind).not.toHaveBeenCalled();
  });

  it("checks pending before the day's count, and both before the budget", async () => {
    const world = setup();
    world.state.pending = 5;
    world.state.created = 99;
    world.state.over = true;
    expect(await world.codeOf("2h")).toBe("limit_reached");
    world.state.pending = 0;
    expect(await world.codeOf("2h")).toBe("rate_limited");
    world.state.created = 0;
    expect(await world.codeOf("2h")).toBe("budget");
    world.state.over = false;
    expect(await world.codeOf("2h")).toBe("ok");
  });

  it("moves a time inside the owner's quiet hours to their end", async () => {
    const { handler, ctx, remind } = setup({
      quietHours: { from: "22:00", to: "07:00" },
      timezone: "Europe/Paris",
    });
    // 00:30 in Paris on the 17th.
    const result = await handler({ when: "2026-10-17T00:30:45+02:00", note: "x" }, ctx());
    expect(result.at).toBe(Date.parse("2026-10-17T07:00:00+02:00"));
    expect(remind).toHaveBeenCalledWith(expect.objectContaining({ notBefore: result.at }));
    // 12:00 is outside the window: kept as asked.
    expect((await handler({ when: "2026-10-17T12:00:00+02:00", note: "x" }, ctx())).at).toBe(
      Date.parse("2026-10-17T12:00:00+02:00"),
    );
  });

  it("passes the caller's taint on to the task (M11R82)", async () => {
    const { handler, ctx, remind } = setup();
    await handler({ when: "2h", note: "x" }, ctx({ tainted: true }));
    expect(remind).toHaveBeenCalledWith(expect.objectContaining({ tainted: true }));
  });

  it("a reminder set during a delegated run keeps that run's requester (RT-16)", async () => {
    const { handler, ctx, remind, state } = setup();
    state.requester = "scout-3c4d";
    await handler({ when: "2h", note: "x" }, ctx());
    expect(remind).toHaveBeenCalledWith(expect.objectContaining({ requestedBy: "scout-3c4d" }));
  });
});

describe("afterQuietHours", () => {
  const night = { from: "22:00", to: "07:00" } as const;
  it("keeps a time outside the window, and with no window", () => {
    expect(afterQuietHours(Date.parse("2026-10-16T12:00:00Z"), night, "UTC")).toBe(
      Date.parse("2026-10-16T12:00:00Z"),
    );
    expect(afterQuietHours(Date.parse("2026-10-16T23:00:00Z"), null, "UTC")).toBe(
      Date.parse("2026-10-16T23:00:00Z"),
    );
  });

  it("moves to the end of a window that crosses midnight, from either side of it", () => {
    expect(afterQuietHours(Date.parse("2026-10-16T23:10:30Z"), night, "UTC")).toBe(
      Date.parse("2026-10-17T07:00:00Z"),
    );
    expect(afterQuietHours(Date.parse("2026-10-17T03:00:00Z"), night, "UTC")).toBe(
      Date.parse("2026-10-17T07:00:00Z"),
    );
  });

  it("moves to the end of a window inside one day, and the end itself is outside it", () => {
    const lunch = { from: "12:00", to: "14:00" } as const;
    expect(afterQuietHours(Date.parse("2026-10-16T12:00:00Z"), lunch, "UTC")).toBe(
      Date.parse("2026-10-16T14:00:00Z"),
    );
    expect(afterQuietHours(Date.parse("2026-10-16T14:00:00Z"), lunch, "UTC")).toBe(
      Date.parse("2026-10-16T14:00:00Z"),
    );
  });

  it("reads the window in the owner's zone", () => {
    // 23:10 UTC is 01:10 in Paris (inside the night); 20:00 UTC is 22:00 there, the window's start.
    expect(afterQuietHours(Date.parse("2026-10-16T20:00:00Z"), night, "Europe/Paris")).toBe(
      Date.parse("2026-10-17T07:00:00+02:00"),
    );
  });
});
