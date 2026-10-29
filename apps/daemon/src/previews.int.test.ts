import { AgentInput, type BoxRef } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { opRows, writeScript } from "./security/testing/agent-bed.ts";
import { rows } from "./security/testing/automation-bed.ts";
import { dialogIdOf, markOf, nextDialog, waitIdle } from "./security/testing/fixtures.ts";
import { type BoxBed, startBoxBed } from "./testing/box-bed.ts";
import { freePort } from "./testing/free-port.ts";
import { startVmBed, type VmBed } from "./testing/vm-bed.ts";

// UX-2 §5 and UX2-R70 through the real daemon on the process backend: a scripted model calls preview_start and preview_stop,
// the real pi-host worker asks the daemon, the daemon asks the real guest, which runs the service as a local process.
// What a person sees: the registry (what `previews.list` and the stream read), the port that answers or does not.

let vmBed: VmBed | undefined;
let boxBed: BoxBed | undefined;
afterEach(async () => {
  await vmBed?.stop();
  await boxBed?.stop();
  vmBed = boxBed = undefined;
});

/** A tiny HTTP server; `lifeMs` makes it end by itself. */
const serverCommand = (port: number, lifeMs?: number): string =>
  `node -e "require('http').createServer((q,r)=>r.end('hello')).listen(${port},'127.0.0.1');${
    lifeMs === undefined ? "" : `setTimeout(()=>process.exit(0),${lifeMs});`
  }"`;
const start = (name: string, command: string, port: number, id: string) => ({
  toolCalls: [{ name: "preview_start", args: { name, command, port }, id }],
});
const stop = (name: string, id: string) => ({ toolCalls: [{ name: "preview_stop", args: { name }, id }] });

const answers = async (port: number): Promise<string | null> => {
  try {
    return await (await fetch(`http://127.0.0.1:${port}/`)).text();
  } catch {
    return null;
  }
};
const registryOf = (bed: { t: { daemon: { inspect: { previews(): unknown } } } }) => {
  const registry = bed.t.daemon.inspect.previews() as {
    list(
      box: BoxRef,
    ): Array<{ name: string; state: string; port: number; network: boolean; reason: string | null }>;
    all(owner: string): Array<{ name: string; box: BoxRef }>;
  } | null;
  if (registry === null) throw new Error("the previews registry is not bound");
  return registry;
};

async function promptAndWait(bed: VmBed, sessionId: string, text: string): Promise<void> {
  const mark = markOf(bed.owner.client);
  await bed.call("sessions.prompt", { sessionId, text });
  await waitIdle(bed.owner.client, mark);
}

describe("preview_start and preview_stop through real workers", () => {
  it("an agent thread's preview_start runs a service and the registry shows it running", async () => {
    const port = await freePort();
    vmBed = await startVmBed({ steps: [] });
    const agentId = await vmBed.createAgent();
    writeScript(vmBed.t, { steps: [start("site", serverCommand(port), port, "p1"), { text: "serving" }] });
    const sessionId = await vmBed.openThread(agentId);
    await promptAndWait(vmBed, sessionId, "serve the site");
    const box: BoxRef = { kind: "agent", id: agentId };
    await vi.waitFor(() => expect(registryOf(vmBed as VmBed).list(box)).toHaveLength(1), { timeout: 30_000 });
    // The agent was created with sandbox.network on: the service is networked (the shell's network, UX2-R68).
    expect(registryOf(vmBed).list(box)[0]).toMatchObject({
      name: "site",
      state: "running",
      port,
      network: true,
    });
    expect(await answers(port)).toBe("hello");
    expect(opRows(vmBed.t, sessionId).map((row) => [row.tool, row.decision])).toEqual([
      ["preview.start", "allow"],
    ]);
  }, 180_000);

  it("network turned on while the worker runs: the service still starts with network false (UX2-R68, through the composition)", async () => {
    const port = await freePort();
    vmBed = await startVmBed({ steps: [] });
    // Supervised: the worker asks the owner before it starts the service, so the run is open while the owner edits the agent.
    const profile = (network: boolean) =>
      AgentInput.parse({
        name: "CyberLooker",
        mode: "supervised",
        preset: "full",
        sandbox: { required: true, network },
      });
    const agentId = (await vmBed.call<{ id: string }>("agents.create", { input: profile(false) })).id;
    writeScript(vmBed.t, { steps: [start("site", serverCommand(port), port, "p1"), { text: "serving" }] });
    const sessionId = await vmBed.openThread(agentId);
    const client = vmBed.owner.client;
    const mark = markOf(client);
    await vmBed.call("sessions.prompt", { sessionId, text: "serve the site" });
    const card = await nextDialog(client, mark);
    // The owner turns the network on while this worker runs: it keeps the profile it started with (W5-R26).
    const view = await vmBed.call<{ revision: number }>("agents.get", { agentId });
    await vmBed.call("agents.update", { agentId, baseRevision: view.revision, input: profile(true) });
    await vmBed.call("sessions.respondDialog", {
      sessionId,
      dialogId: dialogIdOf(card),
      response: { answer: "once" },
    });
    await waitIdle(client, mark);
    const box: BoxRef = { kind: "agent", id: agentId };
    await vi.waitFor(() => expect(registryOf(vmBed as VmBed).list(box)).toHaveLength(1), { timeout: 30_000 });
    expect(registryOf(vmBed).list(box)[0]).toMatchObject({ name: "site", state: "running", network: false });
  }, 180_000);

  it("a box session's preview_start runs one and the registry lists it for the owner", async () => {
    const port = await freePort();
    boxBed = await startBoxBed({ steps: [] });
    const project = await boxBed.createProject("Site");
    writeScript(boxBed.t, { steps: [start("site", serverCommand(port), port, "p1"), { text: "serving" }] });
    const sessionId = await boxBed.openSession(project.root);
    await boxBed.prompt(sessionId, "serve the site");
    const box: BoxRef = { kind: "project", id: project.id };
    await vi.waitFor(() => expect(registryOf(boxBed as BoxBed).list(box)).toHaveLength(1), {
      timeout: 30_000,
    });
    expect(registryOf(boxBed).list(box)[0]).toMatchObject({ name: "site", state: "running", network: true });
    const ownerId = rows<{ owner_id: string }>(
      boxBed.t.home,
      "SELECT owner_id FROM sessions WHERE id = ?",
      sessionId,
    )[0]?.owner_id;
    expect(registryOf(boxBed).all(ownerId ?? "")).toEqual([expect.objectContaining({ name: "site", box })]);
    expect(await answers(port)).toBe("hello");
  }, 180_000);

  it("preview_stop stops it and the registry shows stopped", async () => {
    const port = await freePort();
    boxBed = await startBoxBed({ steps: [] });
    const project = await boxBed.createProject("Site");
    writeScript(boxBed.t, {
      steps: [start("site", serverCommand(port), port, "p1"), stop("site", "p2"), { text: "done" }],
    });
    const sessionId = await boxBed.openSession(project.root);
    await boxBed.prompt(sessionId, "serve then stop");
    const box: BoxRef = { kind: "project", id: project.id };
    await vi.waitFor(() => expect(registryOf(boxBed as BoxBed).list(box)[0]?.state).toBe("stopped"), {
      timeout: 30_000,
    });
    await vi.waitFor(async () => expect(await answers(port)).toBeNull(), { timeout: 15_000 });
  }, 180_000);

  it("a service that ends by itself shows exited", async () => {
    const port = await freePort();
    boxBed = await startBoxBed({ steps: [] });
    const project = await boxBed.createProject("Site");
    writeScript(boxBed.t, {
      steps: [start("brief", serverCommand(port, 2_500), port, "p1"), { text: "ok" }],
    });
    const sessionId = await boxBed.openSession(project.root);
    await boxBed.prompt(sessionId, "serve for a moment");
    const box: BoxRef = { kind: "project", id: project.id };
    await vi.waitFor(() => expect(registryOf(boxBed as BoxBed).list(box)[0]?.state).toBe("exited"), {
      timeout: 30_000,
    });
  }, 180_000);

  it("an agent thread in read-only mode: the worker blocks preview_start and no service starts", async () => {
    const port = await freePort();
    vmBed = await startVmBed({ steps: [] });
    const agentId = await vmBed.createAgent({ mode: "read-only" });
    writeScript(vmBed.t, { steps: [start("site", serverCommand(port), port, "p1"), { text: "blocked" }] });
    const sessionId = await vmBed.openThread(agentId);
    await promptAndWait(vmBed, sessionId, "serve the site");
    // The worker judged it (a `call` row: blocked in a read-only session); the daemon never saw a platform call and the guest
    // never ran the command.
    const judged = () =>
      rows<{ tool: string; decision: string; reason: string }>(
        (vmBed as VmBed).t.home,
        "SELECT tool, decision, reason FROM audit WHERE session_id = ? AND kind = 'call' AND actor = 'worker'",
        sessionId,
      );
    await vi.waitFor(() => expect(judged()).toHaveLength(1), { timeout: 15_000 });
    expect(judged()[0]).toEqual({
      tool: "preview_start",
      decision: "block",
      reason: "edit blocked in a read-only session",
    });
    expect(opRows(vmBed.t, sessionId)).toEqual([]);
    expect(registryOf(vmBed).list({ kind: "agent", id: agentId })).toEqual([]);
    expect(await answers(port)).toBeNull();
  }, 180_000);
});
