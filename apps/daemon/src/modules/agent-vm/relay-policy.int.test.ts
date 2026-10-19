import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startVmBed, type VmBed } from "../../testing/vm-bed.ts";
import type { RelayChild } from "./relay-link.ts";

/*
 * T12's daemon half through a whole daemon: the launch's grant and the agent's policy reach the relay at the launch, follow a
 * pause and a budget, and the revoke goes out when the VM stops. Mutants (RT-43), each run for real: `onLaunch` not wired in
 * compose-agents-vm.ts -> no grant; `onLaunchEnd` not wired -> no revoke; `bindLate` not called in daemon.ts -> every policy is
 * empty (fail closed) and the pause case fails.
 */
let bed: VmBed | undefined;
afterEach(async () => {
  await bed?.stop();
  bed = undefined;
});

function fakeRelay() {
  const sent: Array<Record<string, unknown>> = [];
  const child = Object.assign(new EventEmitter(), {
    send(message: Record<string, unknown>) {
      sent.push(message);
      return true;
    },
    kill: () => true,
  });
  child.emit("message", { type: "relay_ready", port: 1234 });
  return {
    child: child as unknown as RelayChild,
    sent,
    ready: () => child.emit("message", { type: "relay_ready", port: 1234 }),
  };
}
const policies = (sent: Array<Record<string, unknown>>) =>
  sent.filter((message) => message.type === "agent_policy");

describe("the relay link inside the daemon (vm mode)", () => {
  it("grants the launch's key, tells the agent's policy, follows a pause and a budget, and revokes at the VM's stop", async () => {
    const relay = fakeRelay();
    bed = await startVmBed({ steps: [{ text: "ok" }] }, { seams: { relay: { fork: () => relay.child } } });
    relay.ready();
    const agentId = await bed.createAgent();
    await bed.openThread(agentId);
    await vi.waitFor(() => expect(relay.sent.some((m) => m.type === "relay_grant")).toBe(true), {
      timeout: 20_000,
    });
    const grant = relay.sent.find((m) => m.type === "relay_grant") as Record<string, unknown>;
    expect(grant).toMatchObject({ agentId, address: "127.0.0.1" });
    expect(grant.key).toMatch(/^[0-9a-f]{64}$/);
    await vi.waitFor(() => expect(policies(relay.sent).length).toBeGreaterThan(0), { timeout: 20_000 });
    expect(policies(relay.sent).at(-1)).toMatchObject({ agentId, claude: false, blocked: null });

    await bed.call("agents.setPaused", { agentId, paused: true });
    await vi.waitFor(
      () => expect(policies(relay.sent).at(-1)).toMatchObject({ agentId, blocked: "paused" }),
      {
        timeout: 20_000,
      },
    );
    await bed.call("agents.setPaused", { agentId, paused: false });
    await vi.waitFor(() => expect(policies(relay.sent).at(-1)).toMatchObject({ agentId, blocked: null }), {
      timeout: 20_000,
    });

    await bed.vm.runtime.stop(agentId);
    await vi.waitFor(
      () =>
        expect(relay.sent.some((m) => m.type === "relay_revoke" && m.launchId === grant.launchId)).toBe(true),
      { timeout: 20_000 },
    );
  }, 120_000);
});
