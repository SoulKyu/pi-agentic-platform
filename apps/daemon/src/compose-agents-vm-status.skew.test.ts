import { describe, expect, it, vi } from "vitest";
import { guardedLaunch, launchGate } from "./compose-agents-vm-status.ts";
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
