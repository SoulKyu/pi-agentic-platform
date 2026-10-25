import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "./kernel/clock.ts";
import { silentLogger } from "./kernel/logger.ts";
import { guardedLaunch, launchGate, RELAY_READY_WAIT_MS } from "./compose-agents-vm-status.ts";
import { createLaunchRegistry } from "./modules/agent-vm/index.ts";
import { recordLaunches } from "./modules/agent-vm/testing/launch-recorder.ts";
import type { SessionRow } from "./modules/sessions/index.ts";

const PROJECT = "6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d11";
const status = { require: async () => {} };
const stale = { check: vi.fn(async () => "stale" as const) };
const fresh = { check: vi.fn(async () => "ok" as const) };
const rowOf = (extra: Partial<SessionRow> = {}): SessionRow =>
  ({ id: "s1", ownerId: "u1", cwd: "/x", piPath: null, ...extra }) as SessionRow;

describe("the launch gate of a box (stack, relay, bundle)", () => {
  it("refuses a project's launch while the installed bundle is older than the daemon's, before anything spawns", async () => {
    const spawn = vi.fn();
    const launch = guardedLaunch({ spawn }, status, undefined, stale);
    const project = { project: { id: PROJECT }, vm: true } as never;
    await expect(launch.spawn(rowOf(), project, {} as never)).rejects.toMatchObject({
      code: "vm_bundle_stale",
    });
    expect(stale.check).toHaveBeenCalledWith({ kind: "project", id: PROJECT });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("checks an agent's box by its id, and a host row not at all", async () => {
    const spawn = vi.fn(async () => "started" as never);
    const launch = guardedLaunch({ spawn }, status, undefined, stale);
    await expect(
      launch.spawn(rowOf({ agentId: "atlas-1a2b" }), {} as never, {} as never),
    ).rejects.toMatchObject({
      code: "vm_bundle_stale",
    });
    expect(stale.check).toHaveBeenLastCalledWith({ kind: "agent", id: "atlas-1a2b" });
    stale.check.mockClear();
    await expect(launch.spawn(rowOf(), {} as never, {} as never)).resolves.toBe("started");
    expect(stale.check).not.toHaveBeenCalled();
  });

  it("lets a fresh bundle through, and the start of a box asks the same gate", async () => {
    const gate = launchGate(status, undefined, fresh);
    await expect(gate({ kind: "project", id: PROJECT })).resolves.toBeUndefined();
    await expect(
      launchGate(status, undefined, stale)({ kind: "project", id: PROJECT }),
    ).rejects.toMatchObject({
      code: "vm_bundle_stale",
    });
    const down = launchGate({
      require: async () => Promise.reject(Object.assign(new Error("x"), { code: "sandbox_unavailable" })),
    });
    await expect(down(null)).rejects.toMatchObject({ code: "sandbox_unavailable" });
  });
});

describe("the gate reports the checks step (launch progress)", () => {
  const agent = rowOf({ agentId: "atlas-1a2b" });
  const fixture = () => {
    const clock = createFakeClock();
    return { clock, recorder: recordLaunches(createLaunchRegistry({ clock, logger: silentLogger })) };
  };

  it("opens the launch, marks checks, and hands the open launch to the spawn", async () => {
    const { recorder } = fixture();
    const spawn = vi.fn(async () => "started" as never);
    const launch = guardedLaunch({ spawn }, status, undefined, fresh, undefined, recorder.registry);
    await launch.spawn(agent, {} as never, {} as never);
    expect(recorder.log).toEqual(["checks:running", "checks:done"]);
    expect(spawn).toHaveBeenCalledWith(agent, {}, {}, expect.objectContaining({ id: expect.any(String) }));
  });

  it("ends the launch with the refusal's code, checks failed", async () => {
    const { recorder } = fixture();
    const spawn = vi.fn();
    const launch = guardedLaunch({ spawn }, status, undefined, stale, undefined, recorder.registry);
    await expect(launch.spawn(agent, {} as never, {} as never)).rejects.toMatchObject({
      code: "vm_bundle_stale",
    });
    expect(recorder.log).toEqual(["checks:running", "checks:failed", "end:vm_bundle_stale"]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("ends a thrown spawn with its code, and a host row opens nothing", async () => {
    const { recorder } = fixture();
    const spawn = vi.fn(async () => Promise.reject(Object.assign(new Error("x"), { code: "capacity" })));
    const launch = guardedLaunch({ spawn }, status, undefined, fresh, undefined, recorder.registry);
    await expect(launch.spawn(agent, {} as never, {} as never)).rejects.toThrow("x");
    expect(recorder.log.at(-1)).toBe("end:internal");
    await launch.spawn(rowOf(), {} as never, {} as never).catch(() => {});
    expect(recorder.opened()).toBe(1);
  });

  it("says it waits for the relay while it does, and the refusal ends with sandbox_unavailable", async () => {
    const { clock, recorder } = fixture();
    const relay = { ready: () => false, whenReady: () => new Promise<void>(() => {}), clock };
    const spawn = vi.fn();
    const launch = guardedLaunch({ spawn }, status, relay, undefined, undefined, recorder.registry);
    const refused = launch.spawn(agent, {} as never, {} as never).catch((error: unknown) => error);
    expect(recorder.log).toEqual(["checks:running", "wait:relay"]);
    await clock.advance(RELAY_READY_WAIT_MS);
    expect(await refused).toMatchObject({ code: "sandbox_unavailable" });
    expect(recorder.log).toEqual([
      "checks:running",
      "wait:relay",
      "wait:none",
      "checks:failed",
      "end:sandbox_unavailable",
    ]);
  });
});
