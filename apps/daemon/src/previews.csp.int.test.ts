import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { hostSources, serviceCsp } from "./kernel/http/preview/csp.ts";
import { type BoxBed, startBoxBed } from "./testing/box-bed.ts";
import { freePort } from "./testing/free-port.ts";
import {
  declare,
  previewPortOf,
  projectBox,
  registryOf,
  serviceCommand,
  through,
} from "./testing/preview-bed.ts";
import { ownerOf } from "./testing/two-users.ts";

// Decision 139 and UX2-R71 through the real listener: the CSP a service's page gets is built from the daemon's records at the
// moment the token is minted, never from the worker. Exact strings, compared with the policy builder's own output.

const HOST = "cdn.example.com";
let bed: BoxBed;
let previewPort: number;
let origin: string;
beforeAll(async () => {
  bed = await startBoxBed({ steps: [] });
  previewPort = await previewPortOf(bed.t);
  origin = `http://localhost:${previewPort}`;
}, 180_000);
afterAll(async () => bed?.stop());

const cspFor = (hosts: readonly string[]): string =>
  serviceCsp({ appOrigins: [bed.t.origin, bed.t.base], previewOrigin: origin, hosts });
/** The CSP of a page that was served: a 404, 502 or 503 carries the refusal CSP, which is the no-network one. */
const cspOf = async (url: string): Promise<string> => {
  const reply = await through(previewPort, url);
  expect(reply.status).toBe(200);
  return String(reply.headers["content-security-policy"]);
};

async function serveProject(name: string) {
  const project = await bed.createProject(name);
  await bed.startBox(project.id);
  const decl = declare(project, await freePort());
  await bed.call("previews.startProject", { projectId: project.id, ...decl });
  return project;
}
const openOf = (projectId: string) =>
  bed.call<{ url: string }>("previews.open", { box: projectBox(projectId), name: "project" });

describe("the CSP of a service's page", () => {
  it("a networked service's page carries its session's hosts in connect-src, form-action and frame-src", async () => {
    const project = await serveProject("Net");
    await bed.call("projects.setBox", { projectId: project.id, hosts: [HOST] });
    const csp = await cspOf((await openOf(project.id)).url);
    expect(csp).toBe(cspFor(hostSources([HOST], [])));
    for (const directive of ["connect-src", "form-action", "frame-src"])
      expect(
        csp.split("; ").find((part) => part.startsWith(`${directive} `)),
        directive,
      ).toContain(`https://${HOST}`);
    expect(csp).not.toContain("allow-popups");
  });

  it("a service without network gets only the preview origin, data: and blob:", async () => {
    // The agent's own list names a host: a networked form of its page would differ from the no-network one.
    const agentId = await bed.createAgent({
      sandbox: { required: true, network: false },
      allowHosts: [HOST],
    });
    await bed.call("agents.startBox", { agentId });
    const agentBox = { kind: "agent", id: agentId } as const;
    const { id: owner } = await ownerOf(bed);
    const port = await freePort();
    await registryOf(bed.t).start(agentBox, owner, {
      name: "site",
      command: serviceCommand(port),
      port,
      network: false,
    });
    const opened = await bed.call<{ url: string }>("previews.open", { box: agentBox, name: "site" });
    const csp = await cspOf(opened.url);
    expect(csp).toBe(cspFor([]));
    expect(csp).not.toContain("https://");
    expect(csp).toContain(`default-src ${origin} data: blob: 'unsafe-inline' 'unsafe-eval'`);
  });

  it("a host the owner adds after the open is in the next open's CSP, not in the current one", async () => {
    const project = await serveProject("Late");
    const first = await openOf(project.id);
    expect(await cspOf(first.url)).toBe(cspFor([]));
    await bed.call("projects.setBox", { projectId: project.id, hosts: [HOST] });
    // The token already out keeps the list it was minted with, renewals included.
    expect(await cspOf(first.url)).toBe(cspFor([]));
    const second = await openOf(project.id);
    expect(await cspOf(second.url)).toBe(cspFor(hostSources([HOST], [])));
    expect(await cspOf(first.url)).toBe(cspFor([]));
  });
});

describe("a held preview port", () => {
  const holders: Array<ReturnType<typeof createServer>> = [];
  let held: BoxBed | undefined;
  afterEach(async () => {
    await held?.stop();
    held = undefined;
    for (const holder of holders.splice(0))
      await new Promise<void>((resolve) => holder.close(() => resolve()));
  });

  it("makes previews.open and previews.artifact answer unavailable", async () => {
    const holder = createServer();
    holders.push(holder);
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    held = await startBoxBed(
      { steps: [] },
      { config: { previewPort: (holder.address() as AddressInfo).port } },
    );
    const project = await held.createProject("Held");
    await held.startBox(project.id);
    await held.call("previews.startProject", {
      projectId: project.id,
      ...declare(project, await freePort()),
    });
    const opened = await held.owner.client.call("previews.open", {
      box: projectBox(project.id),
      name: "project",
    });
    expect(opened.ok ? "ok" : opened.error.code).toBe("unavailable");
    const artifact = await held.owner.client.call("previews.artifact", {
      sessionId: "any-session",
      entryId: "e1",
      fenceIndex: 0,
    });
    expect(artifact.ok ? "ok" : artifact.error.code).toBe("unavailable");
  });
});
