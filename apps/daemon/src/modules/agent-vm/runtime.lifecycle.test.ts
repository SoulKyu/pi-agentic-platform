import { PapError } from "@pap/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyExit } from "../../kernel/supervisor/exit.ts";
import { CRASH_LIMIT } from "./lifecycle.ts";
import { type Bed, bed, IDLE_MS, settle, specOf, workerInput, agentBox } from "./runtime-fixtures.ts";

const A1 = { kind: "agent", id: "a1" } as const;

let b: Bed;
beforeEach(async () => {
  b = bed();
  await b.runtime.stopAll();
  b.order.length = 0;
  b.backend.stop.mockClear();
});

describe("launch end", () => {
  const revoked = (agentId: string, launch: { launchId: string; token: string }) =>
    b.tokens.check(agentBox(agentId), launch.launchId, launch.token) === false;

  it("revokes and ends the launch when the VM stops", async () => {
    await b.runtime.spawn(specOf("a1"), workerInput(), null);
    const launch = b.launchAt(0);
    await b.runtime.stop(agentBox("a1"));
    expect(revoked("a1", launch)).toBe(true);
    expect(b.ended).toEqual([launch.launchId]);
    expect(b.guestAt(0).shutdown).toHaveBeenCalled();
    expect(b.guestAt(0).handles.at(0)?.stop).toHaveBeenCalled();
    expect(b.backend.stop).toHaveBeenCalledWith(A1, null, expect.any(String));
    expect(b.runtime.phase(agentBox("a1"))).toBe("stopped");
  });

  it("revokes and ends the launch when the VM crashes", async () => {
    await b.runtime.spawn(specOf("a1"), workerInput(), null);
    const launch = b.launchAt(0);
    b.guestAt(0).crash();
    await settle();
    expect(revoked("a1", launch)).toBe(true);
    expect(b.ended).toEqual([launch.launchId]);
  });

  it("revokes and ends the launch when the VM fails to start", async () => {
    b.failStart.error = new Error("vmd refused");
    await expect(b.runtime.spawn(specOf("a1"), workerInput(), null)).rejects.toThrow("vmd refused");
    const launch = b.launchAt(0);
    expect(revoked("a1", launch)).toBe(true);
    expect(b.ended).toEqual([launch.launchId]);
    expect(b.runtime.phase(agentBox("a1"))).toBe("stopped");
    expect(b.runtime.imageOf(launch.launchId)).toBeNull();
  });

  it("revokes, ends and stops the VM when its guest never says hello", async () => {
    b.gateway.awaitGuest.mockRejectedValueOnce(new PapError("timeout"));
    await expect(b.runtime.spawn(specOf("a1"), workerInput(), null)).rejects.toMatchObject({
      code: "timeout",
    });
    const launch = b.launchAt(0);
    expect(revoked("a1", launch)).toBe(true);
    expect(b.ended).toEqual([launch.launchId]);
    expect(b.backend.stop).toHaveBeenCalledWith(A1, null, expect.any(String));
  });

  it("lets a later spawn start a new VM after a failed start", async () => {
    b.failStart.error = new Error("vmd refused");
    await expect(b.runtime.spawn(specOf("a1"), workerInput(), null)).rejects.toThrow();
    b.failStart.error = null;
    await b.runtime.spawn(specOf("a1"), workerInput(), null);
    expect(b.starts).toHaveLength(2);
    expect(b.runtime.phase(agentBox("a1"))).toBe("running");
  });
});

describe("idle stop", () => {
  it("stops the VM PAP_WORKER_IDLE_MINUTES after its last worker exits", async () => {
    const out = await b.runtime.spawn(specOf("a1"), workerInput(), null);
    const guest = b.guestAt(0);
    (out.handle as unknown as { end(): void }).end();
    await b.clock.advance(IDLE_MS - 1);
    expect(b.backend.stop).not.toHaveBeenCalled();
    await b.clock.advance(1);
    expect(b.backend.stop).toHaveBeenCalledWith(A1, null, expect.any(String));
    expect(guest.shutdown).toHaveBeenCalled();
    expect(b.runtime.phase(agentBox("a1"))).toBe("stopped");
  });

  it("never stops the VM while a worker lives", async () => {
    await b.runtime.spawn(specOf("a1"), workerInput(), null);
    const second = await b.runtime.spawn(specOf("a1"), workerInput(), null);
    const guest = b.guestAt(0);
    guest.handles.at(0)?.end();
    await b.clock.advance(IDLE_MS * 3);
    expect(b.backend.stop).not.toHaveBeenCalled();
    (second.handle as unknown as { end(): void }).end();
    await b.clock.advance(IDLE_MS);
    expect(b.backend.stop).toHaveBeenCalledTimes(1);
  });

  it("a spawn after the last worker left cancels the pending stop", async () => {
    const first = await b.runtime.spawn(specOf("a1"), workerInput(), null);
    (first.handle as unknown as { end(): void }).end();
    await b.clock.advance(IDLE_MS - 10);
    await b.runtime.spawn(specOf("a1"), workerInput(), null);
    await b.clock.advance(IDLE_MS);
    expect(b.backend.stop).not.toHaveBeenCalled();
  });
});

describe("crash (RT-40)", () => {
  it("resolves the workers' exits when the VM exits with workers alive", async () => {
    const out = await b.runtime.spawn(specOf("a1"), workerInput(), null);
    const guest = b.guestAt(0);
    guest.crash();
    await expect(out.handle.exited).resolves.toBeDefined();
    expect(b.runtime.phase(agentBox("a1"))).toBe("stopped");
    expect(b.backend.stop).toHaveBeenCalledWith(A1, null, expect.any(String));
  });

  const crashOnce = async (): Promise<void> => {
    await b.runtime.spawn(specOf("a1"), workerInput(), null);
    b.guestAt(-1).crash();
    await settle();
  };

  it("pauses the agent at the third crash in ten minutes and refuses the fourth spawn", async () => {
    for (let i = 0; i < CRASH_LIMIT - 1; i++) await crashOnce();
    expect(b.crashPauses).toEqual([]);
    await crashOnce();
    expect(b.crashPauses).toEqual(["agent:a1"]);
    expect(b.runtime.phase(agentBox("a1"))).toBe("paused");
    const before = b.starts.length;
    await expect(b.runtime.spawn(specOf("a1"), workerInput(), null)).rejects.toMatchObject({
      code: "agent_paused",
    });
    expect(b.starts).toHaveLength(before);
  });

  // M2: one Inbox item per pause. Mutant: onCrashPause called for every crash past the third.
  it("tells the pause once: a VM of the agent that crashes after it is a crash, not another pause", async () => {
    await b.runtime.spawn(specOf("a1", { kind: "isolated", taskKey: "t1" }), workerInput(), null);
    for (let i = 0; i < CRASH_LIMIT; i++) await crashOnce();
    expect(b.crashPauses).toEqual(["agent:a1"]);
    b.guestAt(0).crash();
    await settle();
    expect(b.crashPauses).toEqual(["agent:a1"]);
  });

  it("does not pause when the crashes are spread over more than ten minutes", async () => {
    await crashOnce();
    await crashOnce();
    await b.clock.advance(10 * 60_000);
    await crashOnce();
    expect(b.crashPauses).toEqual([]);
    await b.runtime.spawn(specOf("a1"), workerInput(), null);
  });

  it("does not count another agent's crash, and Resume clears the pause", async () => {
    for (let i = 0; i < CRASH_LIMIT; i++) await crashOnce();
    await b.runtime.spawn(specOf("a2"), workerInput(), null);
    b.runtime.resume(agentBox("a1"));
    await b.runtime.spawn(specOf("a1"), workerInput(), null);
    expect(b.runtime.phase(agentBox("a1"))).toBe("running");
  });

  // Mutant "stopping guard dropped in onClosed": the guest's close after our own stop counts as a crash.
  it("does not count the guest closing after we stopped the VM, even when a worker's exit is slow", async () => {
    for (let i = 0; i < CRASH_LIMIT; i++) {
      const out = await b.runtime.spawn(specOf("a1"), workerInput(), null);
      (out.handle.stop as ReturnType<typeof vi.fn>).mockImplementation(() =>
        Promise.resolve(classifyExit(0, null)),
      );
      await b.runtime.stop(agentBox("a1"));
      b.guestAt(-1).crash();
      await settle();
    }
    expect(b.crashPauses).toEqual([]);
    expect(b.runtime.phase(agentBox("a1"))).toBe("stopped");
  });

  it("does not count a VM that stops on our command, or one that crashes with no worker alive", async () => {
    for (let i = 0; i < CRASH_LIMIT; i++) {
      await b.runtime.spawn(specOf("a1"), workerInput(), null);
      await b.runtime.stop(agentBox("a1"));
    }
    expect(b.crashPauses).toEqual([]);
    for (let i = 0; i < CRASH_LIMIT; i++) {
      const out = await b.runtime.spawn(specOf("a1"), workerInput(), null);
      (out.handle as unknown as { end(): void }).end();
      await settle();
      b.guestAt(-1).crash();
      await settle();
    }
    expect(b.crashPauses).toEqual([]);
  });
});
