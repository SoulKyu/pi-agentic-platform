import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectView } from "@pap/contracts";
import { attach, newRequestId, rpc, untilText } from "./modules/terminal/testing/wire.ts";
import { type BoxBed, startBoxBed } from "./testing/box-bed.ts";

// Journey of boxes lot B2, the terminal: a real shell in the project's box (the guest's pty over the gateway on the process
// backend), the same terminal RPCs and binary frames the web uses.

const IDLE_MS = 4_000;

let bed: BoxBed | undefined;
afterEach(async () => {
  await bed?.stop();
  bed = undefined;
});

const phaseOf = async (b: BoxBed, project: ProjectView): Promise<string> =>
  (await b.call<{ box: { phase: string } }>("projects.box", { projectId: project.id })).box.phase;

describe("the box terminal", () => {
  it("a box terminal opens, echoes, resizes, reattaches, and the box idles out after it detaches", async () => {
    bed = await startBoxBed({ steps: [] }, { config: { workerIdleMs: IDLE_MS } });
    const { client } = bed.owner;
    const project = await bed.createProject("Shell");
    expect(await phaseOf(bed, project)).toBe("stopped");

    // terminal.create starts the stopped box and opens a shell in its project folder.
    const { terminalId } = await rpc(client, "terminal.create", {
      requestId: newRequestId(),
      cwd: project.root,
      cols: 80,
      rows: 24,
    });
    expect(await phaseOf(bed, project)).toBe("running");

    const first = await attach(client, terminalId);
    expect(first.info).toMatchObject({ status: "running", cols: 80, rows: 24 });
    first.type("echo hi-$((1+1))\r");
    await untilText(first, "hi-2");

    await rpc(client, "terminal.resize", { terminalId, cols: 100, rows: 30 });
    first.type("stty size\r");
    await untilText(first, "30 100");
    first.type("pwd\r");
    await untilText(first, "/project");

    // Detach, come back where the stream stopped: the shell and its state are the same.
    const seen = first.received();
    first.ack(seen);
    await rpc(client, "terminal.detach", { streamId: first.streamId });
    const second = await attach(client, terminalId, seen);
    second.type("echo again-$((2+3))\r");
    await untilText(second, "again-5");
    expect(second.text()).not.toContain("hi-2");

    // Detached and silent: nothing keeps the box awake, it idles out.
    await rpc(client, "terminal.detach", { streamId: second.streamId });
    await vi.waitFor(async () => expect(await phaseOf(bed as BoxBed, project)).toBe("stopped"), {
      timeout: 30_000,
      interval: 500,
    });
  }, 120_000);
});
