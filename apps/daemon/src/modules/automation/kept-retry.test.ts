import type { TriggerInput } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createKeptForgetter } from "./kept-folder.ts";
import type { AgentBinding } from "./trigger-agent.ts";

const kept = (agentId: string): TriggerInput =>
  ({ execution: { agent: { agentId, target: "isolated", keep: true } } }) as TriggerInput;

function setup(answers: Array<"done" | "busy">, current: () => TriggerInput | null = () => null) {
  const clock = createFakeClock(1_000);
  const warn = vi.fn();
  const forgetKept = vi.fn(async () => answers.shift() ?? "busy");
  const binding = { ports: () => ({ forgetKept }), bind: () => {} } as unknown as AgentBinding;
  const forget = createKeptForgetter(
    { agents: binding, logger: { warn, error: vi.fn() } as unknown as Logger, clock } as never,
    current,
  );
  const flush = async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  };
  return {
    clock,
    warn,
    forgetKept,
    flush,
    forget,
    run: () => forget.changed("u1", "t1", kept("atlas-1a2b"), null),
  };
}

describe("a forget answered busy (the disk is held) is retried on the clock", () => {
  it("every 60 s until it is done, then no more", async () => {
    const { clock, forgetKept, flush, run, warn } = setup(["busy", "busy", "done"]);
    run();
    await flush();
    expect(forgetKept).toHaveBeenCalledTimes(1);
    await clock.advance(59_999);
    await flush();
    expect(forgetKept).toHaveBeenCalledTimes(1);
    await clock.advance(1);
    await flush();
    expect(forgetKept).toHaveBeenCalledTimes(2);
    await clock.advance(60_000);
    await flush();
    expect(forgetKept).toHaveBeenCalledTimes(3);
    await clock.advance(10 * 60_000);
    await flush();
    expect(forgetKept).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalled();
    expect(forgetKept).toHaveBeenLastCalledWith("u1", "atlas-1a2b", "t1");
  });

  it("gives up after 30 retries and says so once", async () => {
    const { clock, forgetKept, flush, run, warn } = setup([]);
    run();
    await flush();
    for (let i = 0; i < 40; i += 1) {
      await clock.advance(60_000);
      await flush();
    }
    expect(forgetKept).toHaveBeenCalledTimes(31);
    const gaveUp = warn.mock.calls.filter(([msg]) => msg === "kept_forget_gave_up");
    expect(gaveUp).toHaveLength(1);
  });

  it("stops when the trigger keeps that agent's folder again", async () => {
    let current: TriggerInput | null = null;
    const { clock, forgetKept, flush, run } = setup([], () => current);
    run();
    await flush();
    current = kept("atlas-1a2b");
    await clock.advance(60_000);
    await flush();
    expect(forgetKept).toHaveBeenCalledTimes(1);
    await clock.advance(10 * 60_000);
    await flush();
    expect(forgetKept).toHaveBeenCalledTimes(1);
  });

  it("is not stacked: a second forget of the same folder while one retries does nothing", async () => {
    const { forgetKept, flush, run } = setup([]);
    run();
    await flush();
    run();
    await flush();
    expect(forgetKept).toHaveBeenCalledTimes(1);
  });

  it("is stacked per agent: a folder of another agent of the same trigger is forgotten too (M4)", async () => {
    const { forgetKept, flush, forget } = setup([]);
    forget.changed("u1", "t1", kept("atlas-1a2b"), null);
    forget.changed("u1", "t1", kept("sage-0000"), null);
    await flush();
    expect(forgetKept.mock.calls.map((call) => (call as unknown[])[1])).toEqual(["atlas-1a2b", "sage-0000"]);
  });

  it("retries a forget that fails (pap-vmd unreachable), like a held disk", async () => {
    const { clock, forgetKept, flush, run, warn } = setup(["done"]);
    forgetKept.mockRejectedValueOnce(new Error("vmd down"));
    run();
    await flush();
    expect(forgetKept).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("kept_folder_forget_failed", expect.anything());
    await clock.advance(60_000);
    await flush();
    expect(forgetKept).toHaveBeenCalledTimes(2);
    await clock.advance(10 * 60_000);
    await flush();
    expect(forgetKept).toHaveBeenCalledTimes(2);
  });

  it("drops its pending retries at stop", async () => {
    const { clock, forgetKept, flush, run, forget } = setup([]);
    run();
    await flush();
    forget.stop();
    await clock.advance(10 * 60_000);
    await flush();
    expect(forgetKept).toHaveBeenCalledTimes(1);
  });

  it("a thrown read of the trigger in a retry is guarded and frees the folder for the next forget", async () => {
    let boom = true;
    const { clock, forgetKept, flush, run, forget } = setup([], () => {
      if (boom) throw new Error("db closed");
      return null;
    });
    run();
    await flush();
    await clock.advance(60_000);
    await flush();
    expect(forgetKept).toHaveBeenCalledTimes(1);
    boom = false;
    forget.ended("u1", "t1", "atlas-1a2b");
    await flush();
    expect(forgetKept).toHaveBeenCalledTimes(2);
  });
});

describe("a kept task's end forgets a folder its trigger no longer keeps (I1)", () => {
  it("when the trigger is gone, keeps nothing or keeps another agent; not while it keeps that agent", async () => {
    for (const [current, calls] of [
      [() => null, 1],
      [() => ({ execution: { agent: { agentId: "atlas-1a2b", target: "isolated" } } }) as TriggerInput, 1],
      [() => kept("sage-0000"), 1],
      [() => kept("atlas-1a2b"), 0],
    ] as const) {
      const { forgetKept, flush, forget } = setup([], current);
      forget.ended("u1", "t1", "atlas-1a2b");
      await flush();
      expect(forgetKept).toHaveBeenCalledTimes(calls);
    }
  });

  it("a forget that gave up is asked again at the next end", async () => {
    const { clock, forgetKept, flush, run, forget } = setup([]);
    run();
    await flush();
    for (let i = 0; i < 40; i += 1) {
      await clock.advance(60_000);
      await flush();
    }
    expect(forgetKept).toHaveBeenCalledTimes(31);
    forget.ended("u1", "t1", "atlas-1a2b");
    await flush();
    expect(forgetKept).toHaveBeenCalledTimes(32);
  });
});
