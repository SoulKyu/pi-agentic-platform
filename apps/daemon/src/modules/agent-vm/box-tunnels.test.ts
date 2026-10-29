import { PapError } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createBoxTunnels } from "./box-tunnels.ts";
import type { GuestLink } from "./guest-link.ts";

const BOX = { kind: "agent", id: "reviewer-0a1b" } as const;

describe("the box tunnels", () => {
  it("a stopped box answers box_stopped and starts nothing", async () => {
    const link = vi.fn();
    const tunnels = createBoxTunnels({ phase: () => "stopped", link });
    await expect(tunnels.open(BOX, "a1".repeat(16))).rejects.toEqual(new PapError("box_stopped"));
    expect(link).not.toHaveBeenCalled();
  });

  it("a running box opens through its link", async () => {
    const channel = { send: () => true };
    const openTunnel = vi.fn(() => Promise.resolve(channel));
    const tunnels = createBoxTunnels({
      phase: () => "running",
      link: () => ({ openTunnel }) as unknown as GuestLink,
    });
    expect(await tunnels.open(BOX, "a1".repeat(16))).toBe(channel);
    expect(openTunnel).toHaveBeenCalledWith({ service: "a1".repeat(16) });
  });
});
