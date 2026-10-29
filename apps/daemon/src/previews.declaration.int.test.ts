import type { PreviewDecl, PreviewView } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type BoxBed, startBoxBed } from "./testing/box-bed.ts";
import { freePort } from "./testing/free-port.ts";
import { declare, projectBox, registryOf } from "./testing/preview-bed.ts";

// UX-2 final review I1: the START PREVIEW declaration the page reads is what the file says now, whichever way the box came up.

let bed: BoxBed;
beforeAll(async () => {
  bed = await startBoxBed({ steps: [{ text: "ok" }, { text: "ok" }] });
}, 180_000);
afterAll(async () => bed?.stop());

const shown = async (projectId: string): Promise<PreviewDecl | null> =>
  (await bed.call<{ box: { preview: PreviewDecl | null } }>("projects.box", { projectId })).box.preview;

describe("the declaration START PREVIEW reads", () => {
  it("a box started by a session launch records the preview of .pi/project.yaml", async () => {
    const project = await bed.createProject("Launched");
    const decl = declare(project, await freePort());
    expect(await shown(project.id)).toBeNull();
    await bed.openSession(project.root);
    await vi.waitFor(async () => expect(await shown(project.id)).toEqual(decl), { timeout: 30_000 });
  });

  it("an edit while the box runs: the old command answers conflict, the page then reads the new one and it starts", async () => {
    const project = await bed.createProject("Edited");
    await bed.startBox(project.id);
    const old = declare(project, await freePort());
    const current = declare(project, await freePort());
    const refused = await bed.owner.client.call("previews.startProject", { projectId: project.id, ...old });
    expect(refused.ok ? "ok" : refused.error.code).toBe("conflict");
    expect(await shown(project.id)).toEqual(current);
    const started = await bed.call<{ service: PreviewView }>("previews.startProject", {
      projectId: project.id,
      ...current,
    });
    expect(started.service).toMatchObject({ name: "project", port: current.port, state: "running" });
    expect(registryOf(bed.t).list(projectBox(project.id))).toHaveLength(1);
  });
});
