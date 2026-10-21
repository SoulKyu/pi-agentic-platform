import { describe, expect, it, vi } from "vitest";
import { eachOwnTry } from "./compose-agents-vm-hooks.ts";

describe("eachOwnTry (M3)", () => {
  it("runs every step even when one throws, and logs the throw once with the launch id", () => {
    const error = vi.fn();
    const ended = vi.fn();
    eachOwnTry({ error }, "agent_vm_launch_end_hook_failed", "l1", [
      () => {
        throw new Error("relay down");
      },
      ended,
    ]);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("agent_vm_launch_end_hook_failed", {
      err: expect.objectContaining({ message: "relay down" }),
      launchId: "l1",
    });
  });
});
