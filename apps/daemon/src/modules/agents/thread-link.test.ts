import { PapError } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import type { RunEndEvent } from "../runs/index.ts";
import { createThreadLink, type ThreadLinkDeps } from "./thread-link.ts";

function setup() {
  const clock = createFakeClock();
  const answers: Array<"released" | "busy" | "cold" | Error> = [];
  const releaseIdle = vi.fn<ThreadLinkDeps["releaseIdle"]>(() => {
    const answer = answers.shift() ?? "released";
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const ended: Array<(event: RunEndEvent) => void> = [];
  const attention: Array<(sessionId: string, needsInput: boolean) => void> = [];
  const automation = {
    state: vi.fn((): { archived: boolean; running: boolean; needsInput: boolean } | null => null),
    promptPending: vi.fn(() => false),
    archive: vi.fn(),
    abort: vi.fn<(ownerId: string, sessionId: string) => Promise<void>>(async () => {}),
    onAttention: (listener: (sessionId: string, needsInput: boolean) => void) => {
      attention.push(listener);
      return () => void attention.splice(0);
    },
  };
  const applyLive = vi.fn(async () => "applied" as const);
  const warn = vi.fn();
  const logger = { ...silentLogger, warn } as typeof silentLogger;
  const made = createThreadLink({
    automation,
    agentSessions: { applyLive },
    releaseIdle,
    runs: { onRunEnd: (listener) => (ended.push(listener), () => void ended.splice(0)) },
    clock,
    logger,
  });
  const runEnds = (sessionId: string) =>
    ended.forEach((listener) =>
      listener({
        runId: "r",
        sessionId,
        ownerId: "u1",
        taskId: null,
        origin: "user",
        status: "completed",
        costUsd: 0,
        errorClass: null,
        limitResetAt: null,
      }),
    );
  return { ...made, clock, answers, releaseIdle, automation, applyLive, warn, runEnds, attention, ended };
}
const goneRow = () => new PapError("not_found");

describe("the thread link when the thread's row is gone (carry 3)", () => {
  it("is not busy, and has nothing to archive or release", () => {
    const { link, automation, answers, releaseIdle } = setup();
    automation.promptPending.mockImplementation(() => {
      throw goneRow();
    });
    automation.archive.mockImplementation(() => {
      throw goneRow();
    });
    answers.push(goneRow());
    expect(link.busy("u1", "t1")).toBe(false);
    expect(() => link.archive("u1", "t1")).not.toThrow();
    expect(() => link.releaseIdle("u1", "t1")).not.toThrow();
    expect(releaseIdle).toHaveBeenCalledTimes(1);
  });

  it("lets any other failure through to the caller of busy and archive", () => {
    const { link, automation } = setup();
    automation.promptPending.mockImplementation(() => {
      throw new Error("disk");
    });
    automation.archive.mockImplementation(() => {
      throw new Error("disk");
    });
    expect(() => link.busy("u1", "t1")).toThrow("disk");
    expect(() => link.archive("u1", "t1")).toThrow("disk");
  });

  it("is busy while the thread runs or a prompt is pending", () => {
    const { link, automation } = setup();
    automation.state.mockReturnValue({ archived: false, running: true, needsInput: false });
    expect(link.busy("u1", "t1")).toBe(true);
    automation.state.mockReturnValue({ archived: false, running: false, needsInput: false });
    expect(link.busy("u1", "t1")).toBe(false);
    automation.promptPending.mockReturnValue(true);
    expect(link.busy("u1", "t1")).toBe(true);
  });
});

describe("a release that found the worker busy is asked again (carry 2, M11R47)", () => {
  it("asks once when the worker is quiet and nothing waits", async () => {
    const { link, releaseIdle, clock, runEnds } = setup();
    link.releaseIdle("u1", "t1");
    runEnds("t1");
    await clock.advance(5000);
    expect(releaseIdle).toHaveBeenCalledTimes(1);
  });

  it("asks again when the run ends, and again a second later if the worker is not idle yet", async () => {
    const { link, releaseIdle, answers, clock, runEnds } = setup();
    answers.push("busy", "busy", "released");
    link.releaseIdle("u1", "t1");
    expect(releaseIdle).toHaveBeenCalledTimes(1);
    runEnds("t1");
    expect(releaseIdle).toHaveBeenCalledTimes(2);
    await clock.advance(999);
    expect(releaseIdle).toHaveBeenCalledTimes(2);
    await clock.advance(1);
    expect(releaseIdle).toHaveBeenCalledTimes(3);
    expect(clock.pending()).toBe(0);
    runEnds("t1");
    expect(releaseIdle).toHaveBeenCalledTimes(3);
  });

  it("asks again when the thread's question is answered, not when one is raised", () => {
    const { link, releaseIdle, answers, attention } = setup();
    answers.push("busy", "released");
    link.releaseIdle("u1", "t1");
    attention.forEach((listener) => listener("t1", true));
    expect(releaseIdle).toHaveBeenCalledTimes(1);
    attention.forEach((listener) => listener("t1", false));
    expect(releaseIdle).toHaveBeenCalledTimes(2);
  });

  it("gives up after five more asks a second apart, and the next run end still asks", async () => {
    const { link, releaseIdle, answers, clock, runEnds } = setup();
    for (let n = 0; n < 8; n += 1) answers.push("busy");
    link.releaseIdle("u1", "t1");
    runEnds("t1");
    await clock.advance(10_000);
    expect(releaseIdle).toHaveBeenCalledTimes(7);
    expect(clock.pending()).toBe(0);
    answers.length = 0;
    runEnds("t1");
    expect(releaseIdle).toHaveBeenCalledTimes(8);
    runEnds("t1");
    expect(releaseIdle).toHaveBeenCalledTimes(8);
  });

  it("keeps a bounded list: a 65th waiting thread pushes out the oldest", () => {
    const { link, releaseIdle, answers, runEnds } = setup();
    for (let n = 0; n < 65; n += 1) answers.push("busy");
    for (let n = 0; n < 65; n += 1) link.releaseIdle("u1", `t${n}`);
    releaseIdle.mockClear();
    answers.length = 0;
    runEnds("t0");
    expect(releaseIdle).not.toHaveBeenCalled();
    runEnds("t64");
    expect(releaseIdle).toHaveBeenCalledTimes(1);
  });

  it("a worker that vanished ends the wait; a thread whose row is gone is not an error", async () => {
    const { link, answers, clock, runEnds, warn, releaseIdle } = setup();
    answers.push("busy", goneRow());
    link.releaseIdle("u1", "t1");
    runEnds("t1");
    await clock.advance(5000);
    expect(releaseIdle).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    answers.push("busy", new Error("boom"));
    link.releaseIdle("u1", "t2");
    runEnds("t2");
    expect(warn).toHaveBeenCalledWith("agent_release_failed", expect.anything());
    expect(clock.pending()).toBe(0);
  });

  it("stop clears the timers and the listening", () => {
    const { link, answers, clock, runEnds, stop, ended, attention } = setup();
    answers.push("busy", "busy");
    link.releaseIdle("u1", "t1");
    runEnds("t1");
    expect(clock.pending()).toBe(1);
    stop();
    expect(clock.pending()).toBe(0);
    expect(ended).toHaveLength(0);
    expect(attention).toHaveLength(0);
  });
});

describe("applyLive", () => {
  it("hands the change to the sessions module and logs a failure instead of throwing", async () => {
    const { link, applyLive, warn } = setup();
    link.applyLive?.("u1", "t1", { model: { provider: "p", modelId: "m" }, thinking: null });
    expect(applyLive).toHaveBeenCalledWith({
      ownerId: "u1",
      sessionId: "t1",
      model: { provider: "p", modelId: "m" },
    });
    applyLive.mockRejectedValueOnce(new Error("boom") as never);
    link.applyLive?.("u1", "t1", { thinking: "high" });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("agent_apply_live_failed", expect.anything()), {
      timeout: 2000,
    });
    applyLive.mockRejectedValueOnce(goneRow() as never);
    link.applyLive?.("u1", "t1", { thinking: "low" });
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("abort (quarantine, M11R115)", () => {
  it("stops the run of that session, and a session that is gone is nothing to abort", async () => {
    const { link, automation } = setup();
    await link.abort?.("u1", "t1");
    expect(automation.abort).toHaveBeenCalledWith("u1", "t1");
    automation.abort.mockRejectedValueOnce(goneRow());
    await expect(link.abort?.("u1", "t1")).resolves.toBeUndefined();
    automation.abort.mockRejectedValueOnce(new Error("worker closed"));
    await expect(link.abort?.("u1", "t1")).rejects.toThrow("worker closed");
  });
});
