import type { BoxRef, LaunchesStreamEvent, Permission } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createLaunchRegistry } from "./launches.ts";
import { createLaunchStop } from "./launch-stop.ts";

const OWNER = "owner-1";
const MEMBER = "member-2";
const PROJECT: BoxRef = { kind: "project", id: "11111111-1111-4111-8111-111111111111" };
const AGENT: BoxRef = { kind: "agent", id: "helper-1a2b" };
const callerOf = (userId: string, ...permissions: Permission[]) => ({
  userId,
  permissions: new Set<Permission>(permissions),
});

function make(stopBox: (box: BoxRef) => Promise<void> = async () => {}, soleVm?: (box: BoxRef) => boolean) {
  const sent: LaunchesStreamEvent[] = [];
  const registry = createLaunchRegistry({
    clock: createFakeClock(),
    logger: silentLogger,
    ...(soleVm ? { soleVm } : {}),
    hub: {
      publish: (_stream, _key, event) => void sent.push(event as LaunchesStreamEvent),
      registerSnapshot: () => {},
      hasSubscribers: () => false,
    },
  });
  const stop = createLaunchStop();
  stop.bind({ launches: registry, stopBox, logger: silentLogger });
  return { registry, stop, sent };
}

const vmRunning = (handle: { step(step: "vm", state: "running"): void }): void =>
  handle.step("vm", "running");

describe("launches.stop", () => {
  it("ends the launch as stopped and stops the box mid-launch", async () => {
    let rejectStart: (error: Error) => void = () => {};
    const starting = new Promise<void>((_resolve, reject) => (rejectStart = reject));
    const { registry, stop, sent } = make(async () => rejectStart(new Error("worker_failed")));
    const handle = registry.open({ box: PROJECT, owner: OWNER, for: "start" });
    vmRunning(handle);
    const start = starting.catch(() => handle.end(false, "worker_failed"));
    await expect(stop.stop(callerOf(OWNER, "sessions:operate"), handle.id)).resolves.toEqual({});
    await start;
    const ends = sent.filter((event) => event.kind === "end");
    expect(ends).toEqual([{ kind: "end", id: handle.id, done: true, ok: false, code: "stopped" }]);
    expect(registry.activeFor(PROJECT)).toBeNull();
  });

  it("stopping an ended launch answers not_found", async () => {
    const { registry, stop } = make();
    const handle = registry.open({ box: PROJECT, owner: OWNER, for: "start" });
    handle.end(true);
    await expect(stop.stop(callerOf(OWNER, "sessions:operate"), handle.id)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(stop.stop(callerOf(OWNER, "sessions:operate"), "unknown")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("another user's launch is not_found, and the box kind picks the permission", async () => {
    const stopBox = vi.fn(async () => {});
    const { registry, stop } = make(stopBox);
    const mine = registry.open({ box: PROJECT, owner: OWNER, for: "start" });
    const agent = registry.open({ box: AGENT, owner: OWNER, for: "start" });
    vmRunning(mine);
    vmRunning(agent);
    await expect(
      stop.stop(callerOf(MEMBER, "sessions:operate", "agents:operate"), mine.id),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(stop.stop(callerOf(OWNER, "sessions:operate"), agent.id)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(stop.stop(callerOf(OWNER, "agents:operate"), mine.id)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(stopBox).not.toHaveBeenCalled();
    await expect(stop.stop(callerOf(OWNER, "agents:operate"), agent.id)).resolves.toEqual({});
    expect(stopBox).toHaveBeenCalledWith(AGENT);
  });

  it("a runtime.stop failure is logged, not thrown: the launch is already ended", async () => {
    const { registry, stop } = make(() => Promise.reject(new Error("boom")));
    const handle = registry.open({ box: PROJECT, owner: OWNER, for: "start" });
    vmRunning(handle);
    await expect(stop.stop(callerOf(OWNER, "sessions:operate"), handle.id)).resolves.toEqual({});
    expect(registry.activeFor(PROJECT)).toBeNull();
  });

  it("stop is refused during the image step", async () => {
    const stopBox = vi.fn(async () => {});
    const { registry, stop } = make(stopBox);
    const handle = registry.open({ box: PROJECT, owner: OWNER, for: "start" });
    handle.step("image", "running");
    await expect(stop.stop(callerOf(OWNER, "sessions:operate"), handle.id)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(stopBox).not.toHaveBeenCalled();
    expect(registry.activeFor(PROJECT)).not.toBeNull();
  });

  it("stop is refused on the worker step of a box that was already running", async () => {
    const stopBox = vi.fn(async () => {});
    const { registry, stop } = make(stopBox);
    const handle = registry.open({ box: PROJECT, owner: OWNER, for: "send" });
    for (const step of ["checks", "image", "disk", "vm", "guest"] as const) handle.step(step, "skipped");
    handle.step("worker", "running");
    await expect(stop.stop(callerOf(OWNER, "sessions:operate"), handle.id)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(stopBox).not.toHaveBeenCalled();
  });

  it("stop is accepted on the worker step when this launch started the VM", async () => {
    const stopBox = vi.fn(async () => {});
    const { registry, stop } = make(stopBox);
    const handle = registry.open({ box: PROJECT, owner: OWNER, for: "start" });
    for (const step of ["vm", "guest"] as const) {
      handle.step(step, "running");
      handle.step(step, "done");
    }
    handle.step("worker", "running");
    await expect(stop.stop(callerOf(OWNER, "sessions:operate"), handle.id)).resolves.toEqual({});
    expect(stopBox).toHaveBeenCalledWith(PROJECT);
  });

  it("stop is not offered while the agent runs an isolated task VM", async () => {
    const stopBox = vi.fn(async () => {});
    const { registry, stop, sent } = make(stopBox, () => false);
    const handle = registry.open({ box: AGENT, owner: OWNER, for: "open" });
    vmRunning(handle);
    expect(registry.live(OWNER)[0]).not.toHaveProperty("stoppable");
    await expect(stop.stop(callerOf(OWNER, "agents:operate"), handle.id)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(stopBox).not.toHaveBeenCalled();
    expect(registry.activeFor(AGENT)).not.toBeNull();
    expect(sent.every((event) => event.kind !== "launch" || event.launch.stoppable === undefined)).toBe(true);
  });

  it("the daemon marks a launch stoppable at each publish", () => {
    const { registry, sent } = make();
    const handle = registry.open({ box: PROJECT, owner: OWNER, for: "start" });
    handle.step("image", "running");
    handle.step("image", "done");
    vmRunning(handle);
    const last = sent.filter((event) => event.kind === "launch").at(-1);
    expect(last?.kind === "launch" && last.launch.stoppable).toBe(true);
    expect(registry.live(OWNER)[0]?.stoppable).toBe(true);
  });
});
