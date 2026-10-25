import { describe, expect, it, vi } from "vitest";
import { guardedLaunch } from "./compose-agents-vm-status.ts";
import type { SessionRow, VmLaunch } from "./modules/sessions/index.ts";

/* M14 RT-03: the launch gate answers account_disabled before it asks the stack, for an agent's box and a project's. */
const agentRow = { id: "s1", ownerId: "u1", agentId: "scout-0001", agentRole: "thread" } as SessionRow;

describe("guardedLaunch for a disabled owner", () => {
  it("refuses before anything else, for an agent and for a project box, and launches once enabled", async () => {
    const off = new Set<string>();
    const spawn = vi.fn(async () => ({ handle: "h" }));
    const require = vi.fn(async () => {});
    const launch = guardedLaunch({ spawn } as unknown as VmLaunch, { require }, undefined, undefined, (box) =>
      off.has(box.id),
    );
    off.add("scout-0001");
    await expect(launch.spawn(agentRow, {} as never, {} as never)).rejects.toMatchObject({
      code: "account_disabled",
    });
    off.clear();
    off.add("p1");
    const project = { project: { id: "p1" } } as never;
    await expect(launch.spawn(agentRow, project, {} as never)).rejects.toMatchObject({
      code: "account_disabled",
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(require).not.toHaveBeenCalled();
    off.clear();
    await launch.spawn(agentRow, {} as never, {} as never);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("meets the disabled check again right before the spawn, after the gate has awaited", async () => {
    const off = new Set<string>();
    const spawn = vi.fn(async () => ({ handle: "h" }));
    const require = vi.fn(async () => void off.add("scout-0001"));
    const launch = guardedLaunch({ spawn } as unknown as VmLaunch, { require }, undefined, undefined, (box) =>
      off.has(box.id),
    );
    await expect(launch.spawn(agentRow, {} as never, {} as never)).rejects.toMatchObject({
      code: "account_disabled",
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});
