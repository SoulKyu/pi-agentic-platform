import type { ProjectView } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSteppableClock, type SteppableClock } from "./security/testing/steppable-clock.ts";
import { type BoxBed, startBoxBed } from "./testing/box-bed.ts";
import { freePort } from "./testing/free-port.ts";
import { declare, previewPortOf, projectBox, registryOf, through } from "./testing/preview-bed.ts";

// UX-2 Review Focus 3 through the real daemon: a preview never keeps a box awake by itself, and relayed traffic keeps it awake at
// most once per 10 s. The clock is a hand (timers of a minute or more are parked): the box idles out after two minutes.

const IDLE_MS = 120_000;
const TRAFFIC_MS = 10_000;
let clock: SteppableClock;
let bed: BoxBed;
let previewPort: number;

beforeAll(async () => {
  clock = createSteppableClock();
  bed = await startBoxBed({ steps: [] }, { deps: { clock }, config: { workerIdleMs: IDLE_MS } });
  previewPort = await previewPortOf(bed.t);
}, 180_000);
afterAll(async () => bed?.stop());

async function serve(name: string): Promise<{ project: ProjectView; url: string }> {
  const project = await bed.createProject(name);
  await bed.startBox(project.id);
  await bed.call("previews.startProject", { projectId: project.id, ...declare(project, await freePort()) });
  const opened = await bed.call<{ url: string }>("previews.open", {
    box: projectBox(project.id),
    name: "project",
  });
  return { project, url: opened.url };
}
const phaseOf = (project: ProjectView): string => bed.vm.runtime.phase(projectBox(project.id));

describe("a preview and the box's idle time", () => {
  it("a running service with no traffic lets the box stop at its idle time", async () => {
    const { project, url } = await serve("Quiet");
    await clock.advance(IDLE_MS - 20_000);
    expect(phaseOf(project)).toBe("running");
    expect(registryOf(bed.t).list(projectBox(project.id))).toHaveLength(1);
    await clock.advance(30_000);
    await vi.waitFor(() => expect(phaseOf(project)).toBe("stopped"), { timeout: 15_000 });
    await vi.waitFor(() => expect(registryOf(bed.t).list(projectBox(project.id))).toEqual([]), {
      timeout: 15_000,
    });
    expect((await through(previewPort, url)).status).toBe(404);
  });

  it("traffic through a live token resets the idle wait at most once per 10 s", async () => {
    const { project, url } = await serve("Busy");
    const get = async () => (await through(previewPort, url)).status;
    await clock.advance(100_000);
    expect(await get()).toBe(200); // touches: the box now idles out at +220 s
    await clock.advance(TRAFFIC_MS / 2);
    expect(await get()).toBe(200); // inside the 10 s: it does not touch again
    await clock.advance(95_000); // +200 s: a box never touched would have stopped at +120 s
    expect(phaseOf(project)).toBe("running");
    await clock.advance(21_000); // +221 s: stopped from the first touch (+100 s), not from the second (+105 s)
    await vi.waitFor(() => expect(phaseOf(project)).toBe("stopped"), { timeout: 15_000 });
  });
});
