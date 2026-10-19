import net from "node:net";
import { GUEST_BOOT_TIMEOUT_MS } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { daemon, IDENTITY, start, TOKEN } from "../testing/guest-harness.ts";

describe("runGuest start", () => {
  it("grows, seeds, then dials and sends the guest hello first", async () => {
    const run = await start();
    await run.hello();
    expect(run.order).toEqual(["grow", "seed"]);
    expect(run.gateway.frames[0]).toEqual({
      type: "hello",
      role: "guest",
      agentId: IDENTITY.PAP_AGENT_ID,
      launchId: IDENTITY.PAP_LAUNCH_ID,
      token: TOKEN,
      protocol: 1,
      imageTag: IDENTITY.PAP_IMAGE_TAG,
    });
    expect(run.exits).toEqual([]);
  });

  it("goes on when the file system cannot grow, and says so", async () => {
    const run = await start({ grow: () => Promise.reject(new Error("resize2fs: no space")) });
    await run.hello();
    expect(run.order).toEqual(["seed"]);
    expect(run.logs.join("\n")).toContain("could not grow");
  });

  it("exits 1 without dialing when the seed fails", async () => {
    const dialed: string[] = [];
    const run = await start({
      seed: () => {
        throw new Error("planted link");
      },
      connect: (address) => {
        dialed.push(address);
        return net.connect(1, "127.0.0.1");
      },
    });
    await run.done;
    expect(run.exits).toEqual([1]);
    expect(dialed).toEqual([]);
  });

  it("exits 1 when the environment cannot make a hello", async () => {
    const run = await start({ env: { PAP_AGENT_ID: "Not An Id" } });
    await run.done;
    expect(run.exits).toEqual([1]);
  });

  it("retries a refused dial every second", async () => {
    let attempts = 0;
    const gateway = await daemon();
    const run = await start({
      connect: () => {
        attempts += 1;
        return net.connect(attempts <= 3 ? 1 : gateway.port, "127.0.0.1");
      },
    });
    for (let step = 0; step < 3; step += 1) {
      await vi.waitFor(() => expect(run.clock.sleeping()).toBe(1));
      run.clock.advance(1000);
    }
    await vi.waitFor(() => expect(gateway.frames).toHaveLength(1));
    expect(attempts).toBe(4);
    expect(run.exits).toEqual([]);
  });

  // Mutant: no deadline -> the guest retries for ever; killed by this case ending in exit 1 at 60 s.
  it("gives up with exit 1 once GUEST_BOOT_TIMEOUT_MS has passed", async () => {
    let attempts = 0;
    const run = await start({
      connect: () => {
        attempts += 1;
        return net.connect(1, "127.0.0.1");
      },
    });
    while (run.exits.length === 0) {
      await vi.waitFor(() => expect(run.exits.length > 0 || run.clock.sleeping() > 0).toBe(true));
      if (run.exits.length === 0) run.clock.advance(1000);
    }
    expect(run.exits).toEqual([1]);
    expect(run.clock.now()).toBe(GUEST_BOOT_TIMEOUT_MS);
    expect(attempts).toBe(GUEST_BOOT_TIMEOUT_MS / 1000 + 1);
  });
});
