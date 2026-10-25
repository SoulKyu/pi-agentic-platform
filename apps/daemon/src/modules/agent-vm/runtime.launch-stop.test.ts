import type { LaunchesStreamEvent, Permission } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { harness } from "./gateway-fixtures.ts";
import { createLaunchStop } from "./launch-stop.ts";
import { createLaunchRegistry } from "./launches.ts";
import { agentBox, bed, settle, specOf, workerInput } from "./runtime-fixtures.ts";

const OWNER = "owner-1";
const caller = { userId: OWNER, permissions: new Set<Permission>(["agents:operate"]) };

/** The real gateway core (its guest wait), the runtime bed and a real registry: Stop mid-launch end to end. */
async function rig() {
  const h = harness();
  const b = bed({ gateway: h.gateway });
  await b.runtime.stopAll();
  b.backend.stop.mockClear();
  const sent: LaunchesStreamEvent[] = [];
  const registry = createLaunchRegistry({
    clock: b.clock,
    logger: silentLogger,
    soleVm: (box) => b.runtime.liveVms(box) <= 1,
    hub: {
      publish: (_stream, _key, event) => void sent.push(event as LaunchesStreamEvent),
      registerSnapshot: () => {},
      hasSubscribers: () => false,
    },
  });
  const stop = createLaunchStop();
  stop.bind({ launches: registry, stopBox: (box) => b.runtime.stop(box), logger: silentLogger });
  const handle = registry.open({ box: agentBox("a1"), owner: OWNER, for: "open" });
  return { b, h, sent, stop, handle };
}

const ends = (sent: LaunchesStreamEvent[]) => sent.filter((event) => event.kind === "end");

describe("Stop in the middle of a launch (R11)", () => {
  it("stop during guest ends the wait at once: the start rejects stopped, nothing is left", async () => {
    const { b, h, sent, stop, handle } = await rig();
    const spawning = b.runtime
      .spawn(specOf("a1", { launch: handle }), workerInput(), null)
      .catch((e: unknown) => e);
    await settle();
    await stop.stop(caller, handle.id);
    // No clock is advanced: the guest wait of 60 s must not be what ends the start.
    expect(await spawning).toMatchObject({ code: "stopped" });
    expect(b.runtime.phase(agentBox("a1"))).toBe("stopped");
    expect(b.ended).toHaveLength(1);
    expect(b.guestAt(0).handles).toHaveLength(0);
    expect(ends(sent)).toEqual([{ kind: "end", id: handle.id, done: true, ok: false, code: "stopped" }]);
    expect(h.clock.now()).toBeGreaterThanOrEqual(0);
  });

  it("stop during vm: the late start is stopped again and rejects stopped", async () => {
    const { b, sent, stop, handle } = await rig();
    let release: (value: { address: string }) => void = () => {};
    b.backend.start.mockImplementationOnce(() => {
      handle.step("vm", "running");
      return new Promise((resolve) => (release = resolve));
    });
    const spawning = b.runtime
      .spawn(specOf("a1", { launch: handle }), workerInput(), null)
      .catch((e: unknown) => e);
    await settle();
    await stop.stop(caller, handle.id);
    release({ address: "10.213.0.9" });
    expect(await spawning).toMatchObject({ code: "stopped" });
    expect(b.runtime.phase(agentBox("a1"))).toBe("stopped");
    expect(b.grants).toEqual([]);
    expect(ends(sent)).toHaveLength(1);
  });

  it("stopping an agent thread launch leaves the agent's other VM running", async () => {
    const b = bed();
    await b.runtime.stopAll();
    b.backend.stop.mockClear();
    const registry = createLaunchRegistry({
      clock: b.clock,
      logger: silentLogger,
      soleVm: (box) => b.runtime.liveVms(box) <= 1,
    });
    const stop = createLaunchStop();
    stop.bind({ launches: registry, stopBox: (box) => b.runtime.stop(box), logger: silentLogger });
    await b.runtime.spawn(specOf("a1", { kind: "isolated", taskKey: "t1" }), workerInput(), null);
    expect(b.runtime.liveVms(agentBox("a1"))).toBe(1);
    const handle = registry.open({ box: agentBox("a1"), owner: OWNER, for: "open" });
    b.gateway.awaitGuest.mockImplementationOnce(() => new Promise(() => {}));
    void b.runtime.spawn(specOf("a1", { launch: handle }), workerInput(), null).catch(() => {});
    await settle();
    expect(b.runtime.liveVms(agentBox("a1"))).toBe(2);
    await expect(stop.stop(caller, handle.id)).rejects.toMatchObject({ code: "not_found" });
    expect(b.backend.stop).not.toHaveBeenCalled();
    expect(b.runtime.phase(agentBox("a1"))).not.toBe("stopped");
  });
});
