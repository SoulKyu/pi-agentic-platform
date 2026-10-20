import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { pidsWithEnv, startRuntimeBed, type RuntimeBed } from "./testing/runtime-bed.ts";

/*
 * T6 with a real guest (T5) and a real pi-host worker over the socket, on the scripted provider. Mutants (RT-43), each run for
 * real: the guest's token scrub removed (`takeGatewayToken` returns without the re-exec) -> "holds no gateway token" fails.
 */
let bed: RuntimeBed | undefined;
afterEach(async () => {
  await bed?.dispose();
  bed = undefined;
});

describe("the gateway with a real guest and a real worker", () => {
  it("answers get_state over the socket, resolves exited at stop, and no process holds the gateway token (R24)", async () => {
    bed = await startRuntimeBed();
    const { handle, slot, ready } = await bed.spawnReady("scout-ab12");
    expect(ready.type).toBe("ready");
    const state = await handle.request({ type: "get_state" });
    expect(state.success).toBe(true);
    expect(state.data).toMatchObject({ isStreaming: false });

    // The launch's token lives nowhere in the environments of the guest or of the worker (a worker reads it from fd 3).
    const launch = bed.launches[0];
    expect(launch).toBeDefined();
    const worker = pidsWithEnv(`PAP_WORKER_SLOT=${slot}`);
    // The worker inherits the guest's identity variables, so the guest is the launch's other process.
    const guest = pidsWithEnv(`PAP_LAUNCH_ID=${launch?.launchId}`).filter((pid) => !worker.includes(pid));
    expect(guest).toHaveLength(1);
    expect(worker).toHaveLength(1);
    for (const pid of [...guest, ...worker]) {
      const environ = readFileSync(`/proc/${pid}/environ`, "latin1");
      expect(environ.includes(launch?.token ?? "no-token")).toBe(false);
      expect(environ.includes("PAP_GATEWAY_TOKEN")).toBe(false);
    }

    const exit = await handle.stop();
    expect(exit).toBeDefined();
    await expect(handle.exited).resolves.toBe(exit);
    expect(pidsWithEnv(`PAP_WORKER_SLOT=${slot}`)).toEqual([]);
  }, 120_000);
});
