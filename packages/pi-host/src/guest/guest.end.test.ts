import { AGENT_VM_MAX_FRAME_BYTES } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { GUEST_SHUTDOWN_GRACE_MS } from "./guest.ts";
import { SLOT_B, spawnCommand, start } from "../testing/guest-harness.ts";

describe("runGuest ending", () => {
  async function twoWorkers() {
    const run = await start();
    await run.hello();
    run.gateway.send(spawnCommand());
    run.gateway.send(spawnCommand({ slot: SLOT_B }));
    await vi.waitFor(() => expect(run.children).toHaveLength(2));
    return run;
  }

  it("on shutdown signals every worker with SIGTERM, then exits 0 once they are gone", async () => {
    const run = await twoWorkers();
    run.gateway.send({ type: "shutdown" });
    await vi.waitFor(() =>
      expect(run.killed).toEqual([
        [1000, "SIGTERM"],
        [1001, "SIGTERM"],
      ]),
    );
    expect(run.exits).toEqual([]);
    for (const child of run.children) child.exit(0);
    await run.done;
    expect(run.exits).toEqual([0]);
    expect(run.clock.pending()).toBe(0);
  });

  it("on shutdown sends SIGKILL after GUEST_SHUTDOWN_GRACE_MS to a worker that stays, then exits 0", async () => {
    const run = await twoWorkers();
    run.gateway.send({ type: "shutdown" });
    await vi.waitFor(() => expect(run.killed).toHaveLength(2));
    run.clock.advance(GUEST_SHUTDOWN_GRACE_MS - 1);
    expect(run.exits).toEqual([]);
    run.clock.advance(1);
    await run.done;
    expect(run.killed.slice(2)).toEqual([
      [1000, "SIGKILL"],
      [1001, "SIGKILL"],
    ]);
    expect(run.exits).toEqual([0]);
  });

  it("on shutdown with no worker exits 0 at once", async () => {
    const run = await start();
    await run.hello();
    run.gateway.send({ type: "shutdown" });
    await run.done;
    expect(run.exits).toEqual([0]);
  });

  it("kills every worker and exits 1 when the gateway closes", async () => {
    const run = await twoWorkers();
    run.gateway.hangUp();
    await run.done;
    expect(run.killed).toEqual([
      [1000, "SIGKILL"],
      [1001, "SIGKILL"],
    ]);
    expect(run.exits).toEqual([1]);
  });

  it("treats a frame over the bound as a closed gateway", async () => {
    const run = await twoWorkers();
    const head = Buffer.alloc(4);
    head.writeUInt32BE(AGENT_VM_MAX_FRAME_BYTES + 1, 0);
    run.gateway.sendRaw(head);
    await run.done;
    expect(run.exits).toEqual([1]);
    expect(run.killed).toHaveLength(2);
  });

  it("exits once even when the gateway closes after a shutdown", async () => {
    const run = await start();
    await run.hello();
    run.gateway.send({ type: "shutdown" });
    await run.done;
    run.gateway.hangUp();
    await vi.waitFor(() => expect(run.exits).toEqual([0]));
  });
});
