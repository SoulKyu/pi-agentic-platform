import { connect, createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { writeScript } from "./security/testing/agent-bed.ts";
import { rows } from "./security/testing/automation-bed.ts";
import { dialogIdOf, isDialog, markOf, nextDialog } from "./security/testing/fixtures.ts";
import { loopbackVmSeams } from "./modules/egress/testing/vm.ts";
import { type BoxBed, startBoxBed } from "./testing/box-bed.ts";

// "Allow this host" in a project's box: the host joins that project's list (audited, without the host in the row), and the
// next connection of the box passes the egress proxy. The box is the process backend's local guest: the test dials the proxy
// from its address, as the box's shell would, to a local origin standing behind the name.

let bed: BoxBed | undefined;
let origin: Server | undefined;
afterEach(async () => {
  await bed?.stop();
  bed = undefined;
  await new Promise((resolve) => (origin ? origin.close(resolve) : resolve(undefined)));
  origin = undefined;
});

const listening = (server: Server): Promise<number> =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
  );

/** One CONNECT through the box proxy: the first line of its answer. */
function connectThrough(proxyPort: number, target: string): Promise<string> {
  return new Promise((resolve) => {
    const socket: Socket = connect({ host: "127.0.0.1", port: proxyPort });
    socket.on("error", () => resolve("error"));
    let head = "";
    socket.on("data", (chunk: Buffer) => {
      head += chunk.toString();
      if (!head.includes("\r\n")) return;
      resolve(head.split("\r\n")[0] ?? "");
      socket.destroy();
    });
    socket.once("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
  });
}

describe("a host allowed in a project's box", () => {
  it("allow this host adds it to the project and the next connection passes", async () => {
    origin = createServer((socket) => socket.pipe(socket));
    const originPort = await listening(origin);
    bed = await startBoxBed(
      { steps: [] },
      { seams: { proxy: loopbackVmSeams({ "api.example.test": { 443: originPort } }) } },
    );
    const mine = await bed.createProject("Docs");
    const other = await bed.createProject("Other");
    const root = mine.root;
    writeScript(bed.t, {
      steps: [
        {
          toolCalls: [
            {
              name: "network_request",
              args: { host: "api.example.test", reason: "read the docs" },
              id: "n1",
            },
          ],
        },
        { text: "thanks" },
      ],
    });
    const sessionId = await bed.openSession(root);
    // Before: the box's connection is refused, nothing was listed.
    expect(await connectThrough(bed.vm.proxyPort, "api.example.test:443")).toMatch(/^HTTP\/1\.1 403/);

    const client = bed.owner.client;
    const mark = markOf(client);
    await bed.call("sessions.prompt", { sessionId, text: "look at the docs" });
    const card = await nextDialog(client, mark);
    await bed.call("sessions.respondDialog", {
      sessionId,
      dialogId: dialogIdOf(card),
      response: { answer: "host" },
    });
    await client.waitForEvent((f) => (f.event as { status?: string }).status === "idle" && f.seq > card.seq);
    expect(client.events.some(isDialog)).toBe(true);

    // The host is on this project's list and on no other; the audit row names the project, never the host.
    const hostsOf = async (projectId: string) =>
      (await bed?.call<{ box: { hosts: string[] } }>("projects.box", { projectId }))?.box.hosts;
    expect(await hostsOf(mine.id)).toEqual(["api.example.test"]);
    expect(await hostsOf(other.id)).toEqual([]);
    const audited = rows<{ detail: string; actor: string }>(
      bed.t.home,
      "SELECT detail, actor FROM audit WHERE reason = 'project_host_added'",
    );
    expect(audited).toHaveLength(1);
    expect(JSON.parse(audited[0]?.detail ?? "{}")).toEqual({ projectId: mine.id });
    expect(audited[0]?.actor).toBe("user");

    // After: the next connection passes the proxy, and a host nobody allowed still does not.
    expect(await connectThrough(bed.vm.proxyPort, "api.example.test:443")).toMatch(/^HTTP\/1\.1 200/);
    expect(await connectThrough(bed.vm.proxyPort, "elsewhere.example.test:443")).toMatch(/^HTTP\/1\.1 403/);
  }, 180_000);
});
