import { PapError } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import type { HelperPool } from "../../kernel/helper/pool.ts";
import { testCaller } from "../../testing/caller.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createPiWriteQueue } from "../../kernel/pi-write-queue.ts";
import { createModelsModule } from "./index.ts";
import { signInDeps } from "./testing/bed.ts";

/*
 * J1: the VM relay learns of a change of the agents' allowed models from here (ADR 0068: the same moment `models.available` is
 * cleared). Mutants (RT-43): `onWrote` not called from `wrote()` -> both cases fail; called before the helper run settled ->
 * "after the write settled" fails.
 */
function module(outcome: "ok" | "fail") {
  const pool: HelperPool = {
    run: () => ({
      done: outcome === "ok" ? Promise.resolve({ patterns: null }) : Promise.reject(new PapError("conflict")),
      answer: () => false,
      cancel: () => {},
    }),
    active: () => 0,
    stopAll: async () => {},
  };
  const built = createModelsModule({
    helpers: pool,
    projects: { covers: () => true },
    logger: captureLogger().logger,
    ...signInDeps,
    writes: createPiWriteQueue(),
  });
  return built;
}

describe("ModelsPort.onChanged", () => {
  it("fires after a write of Pi's files settled", async () => {
    const built = module("ok");
    const heard = vi.fn();
    built.port.onChanged(heard);
    expect(heard).not.toHaveBeenCalled();
    await built.rpc["models.setEnabled"]({ op: { op: "clear" } } as never, { caller: testCaller() } as never);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("fires after a write that failed too: it may have landed", async () => {
    const built = module("fail");
    const heard = vi.fn();
    built.port.onChanged(heard);
    await expect(
      built.rpc["models.setEnabled"]({ op: { op: "clear" } } as never, { caller: testCaller() } as never),
    ).rejects.toThrow();
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
