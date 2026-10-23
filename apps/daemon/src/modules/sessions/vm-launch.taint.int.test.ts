import { connect, createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rows } from "../../security/testing/automation-bed.ts";
import { markOf, waitIdle } from "../../security/testing/fixtures.ts";
import { loopbackVmSeams } from "../egress/testing/vm.ts";
import { startVmBed, type VmBed } from "../../testing/vm-bed.ts";

// What the daemon's proxy saw taints the VM's sessions (spec 4), whatever the VM's own workers report. The process backend's VM
// sits at 127.0.0.1; the listed name only reaches a local echo server.
let bed: VmBed | undefined;
let echo: Server | undefined;
afterEach(async () => {
  for (const socket of open.splice(0)) socket.destroy();
  await bed?.stop();
  bed = undefined;
  await new Promise((resolve) => echo?.close(resolve));
  echo = undefined;
});
// Tests stay on loopback: the proxy's network seams resolve this name to 127.7.0.1 and connect to a local echo server.
const LISTED = "feed.example.test";
/** A VM bed whose proxy reaches only the local echo server. */
async function start(script: object): Promise<VmBed> {
  const server = createServer((socket) => socket.on("error", () => {}).pipe(socket));
  echo = server;
  const echoPort = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
  );
  bed = await startVmBed(script, { seams: { proxy: loopbackVmSeams({ [LISTED]: { 443: echoPort } }) } });
  return bed;
}

const prompt = async (b: VmBed, sessionId: string, text: string) => {
  const mark = markOf(b.owner.client);
  await b.call("sessions.prompt", { sessionId, text });
  await waitIdle(b.owner.client, mark);
};
const open: Socket[] = [];
/** One tunnel from the VM's address to the listed host: the proxy judges it; the test drops it at the end. */
const tunnel = (b: VmBed): Promise<void> =>
  new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: b.vm.proxyPort });
    open.push(socket);
    socket.on("error", () => resolve());
    socket.once("data", () => resolve()); // the 200 of the tunnel
    socket.write(`CONNECT ${LISTED}:443 HTTP/1.1\r\nHost: ${LISTED}:443\r\n\r\n`);
  });
const taintedIds = (b: VmBed): string[] =>
  rows<{ session_id: string }>(
    b.t.home,
    "SELECT session_id FROM session_policy WHERE tainted_at IS NOT NULL",
  ).map((row) => row.session_id);
const outsideRows = (b: VmBed): string[] =>
  rows<{ session_id: string }>(b.t.home, "SELECT session_id FROM audit WHERE reason = 'tainted_outside'").map(
    (row) => row.session_id,
  );
const childIds = (b: VmBed): string[] =>
  rows<{ id: string }>(b.t.home, "SELECT id FROM sessions WHERE agent_role = 'child'").map((row) => row.id);

describe("the daemon taints a VM's sessions from its proxy (spec 4, B1)", () => {
  it("taints the thread and its child once each, however many tunnels", async () => {
    const script = {
      steps: [{ toolCalls: [{ name: "subagent", args: { task: "CHILD" }, id: "s1" }] }, { text: "done" }],
    };
    const b = await start(script);
    const agentId = await b.createAgent({ allowHosts: [LISTED] });
    const thread = await b.openThread(agentId);
    await prompt(b, thread, "delegate");
    await vi.waitFor(() => expect(childIds(b)).toHaveLength(1));
    const [child] = childIds(b);
    expect(taintedIds(b)).not.toContain(thread);
    expect(taintedIds(b)).not.toContain(child);

    await tunnel(b);
    await tunnel(b);
    await vi.waitFor(() => expect(outsideRows(b)).toHaveLength(2));
    expect(taintedIds(b)).toEqual(expect.arrayContaining([thread, child]));
    await tunnel(b);
    expect([...outsideRows(b)].sort()).toEqual([thread, child].sort());
  }, 120_000);

  it("leaves a thread clean when the VM reached nothing the proxy let through", async () => {
    const b = await start({ steps: [{ text: "ready" }] });
    const thread = await b.openThread(await b.createAgent({ allowHosts: [LISTED] }));
    await prompt(b, thread, "hello");
    expect(taintedIds(b)).not.toContain(thread);
    expect(outsideRows(b)).toEqual([]);
  }, 120_000);
});
