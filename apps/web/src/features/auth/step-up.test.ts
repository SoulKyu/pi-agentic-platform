import { describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/index.ts";
import { withStepUp } from "./step-up.ts";

describe("withStepUp", () => {
  it("asks for the password once on step_up_required and sends the same command again", async () => {
    const seen: string[] = [];
    const run = vi.fn(async (commandId: string) => {
      seen.push(commandId);
      if (seen.length === 1) throw new RpcError("step_up_required");
      return "done";
    });
    const ask = vi.fn(async () => true);
    expect(await withStepUp(run, ask, "cmd-0000001")).toBe("done");
    expect(seen).toEqual(["cmd-0000001", "cmd-0000001"]);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("stops when the person cancels, and does not loop on a second step_up_required", async () => {
    const run = vi.fn(async () => {
      throw new RpcError("step_up_required");
    });
    await expect(withStepUp(run, async () => false, "cmd-0000002")).rejects.toMatchObject({
      code: "step_up_required",
    });
    expect(run).toHaveBeenCalledTimes(1);
    const ask = vi.fn(async () => true);
    run.mockClear();
    await expect(withStepUp(run, ask, "cmd-0000003")).rejects.toMatchObject({ code: "step_up_required" });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("lets every other failure through without asking, and never sends a timed-out mutation again", async () => {
    const ask = vi.fn(async () => true);
    for (const code of ["timeout", "connection_lost", "not_found"] as const) {
      const run = vi.fn(async () => {
        throw new RpcError(code);
      });
      await expect(withStepUp(run, ask, "cmd-0000004")).rejects.toMatchObject({ code });
      expect(run).toHaveBeenCalledTimes(1);
    }
    expect(ask).not.toHaveBeenCalled();
  });
});
