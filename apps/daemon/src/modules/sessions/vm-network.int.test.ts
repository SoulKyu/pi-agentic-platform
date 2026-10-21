import { afterEach, describe, expect, it } from "vitest";
import { PermissionsView } from "@pap/contracts";
import { bash } from "../../security/testing/agent-bed.ts";
import { isDialog, markOf, waitIdle } from "../../security/testing/fixtures.ts";
import { startVmBed, type VmBed } from "../../testing/vm-bed.ts";

let bed: VmBed | undefined;
afterEach(async () => {
  await bed?.stop();
  bed = undefined;
});
const start = (script: object) => startVmBed(script).then((started) => (bed = started));
const prompt = async (b: VmBed, sessionId: string, text: string) => {
  const mark = markOf(b.owner.client);
  await b.call("sessions.prompt", { sessionId, text });
  await waitIdle(b.owner.client, mark);
};
const tainted = (b: VmBed): boolean => JSON.stringify(b.owner.client.events).includes('"tainted":true');

describe("an agent in a VM with host entries (decision 119, C1)", () => {
  it("starts a thread when allowHosts holds a port and an IP, and its Permissions view loads", async () => {
    const b = await start({ steps: [{ text: "Hello from the VM." }] });
    const agentId = await b.createAgent({ allowHosts: ["k8s.lan:6443", "192.168.1.40", "[fd00::5]:8080"] });
    const sessionId = await b.openThread(agentId);
    await prompt(b, sessionId, "Say hello");
    expect(JSON.stringify(b.owner.client.events).includes("Hello from the VM.")).toBe(true);
    const view = PermissionsView.parse(await b.call("agents.permissions", { agentId }));
    expect(view.hosts).toEqual(["k8s.lan:6443", "192.168.1.40", "[fd00::5]:8080"]);
  }, 120_000);
});

describe("the agent's network switch in a VM (AVM2-E11, C2)", () => {
  // The process backend cannot run the root shell: the call is judged (and taints) before it fails to run.
  it("taints the session after a shell command when the network is on, and asks nothing", async () => {
    const b = await start({ steps: [bash("echo hi", "b1"), { text: "done" }] });
    const sessionId = await b.openThread(await b.createAgent({ sandbox: { required: true, network: true } }));
    await prompt(b, sessionId, "Run it");
    expect(tainted(b)).toBe(true);
    expect(b.owner.client.events.some(isDialog)).toBe(false);
  }, 120_000);

  it("leaves the session clean when the network is off", async () => {
    const b = await start({ steps: [bash("echo hi", "b1"), { text: "done" }] });
    const sessionId = await b.openThread(
      await b.createAgent({ sandbox: { required: true, network: false } }),
    );
    await prompt(b, sessionId, "Run it");
    expect(tainted(b)).toBe(false);
  }, 120_000);
});
