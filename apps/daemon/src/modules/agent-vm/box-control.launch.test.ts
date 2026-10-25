import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AGENT_RESOURCES, PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectBoxRow } from "../../kernel/boxes.ts";
import type { ImageObserver } from "../../kernel/launches.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { type BoxControlDeps, createBoxControl, createLaunchRegistry } from "./index.ts";
import { projectLayoutOf } from "./project-layout.ts";
import { bed, IMAGE, PROJECT_ID, type Bed } from "./runtime-fixtures.ts";
import { createFakeVmd } from "./testing/fake-vmd.ts";
import { recordLaunches } from "./testing/launch-recorder.ts";

const BOX = { kind: "project", id: PROJECT_ID } as const;
const ROW: ProjectBoxRow = {
  ownerId: "owner",
  root: "/boxes/x/project",
  resources: { ...DEFAULT_AGENT_RESOURCES, memoryMb: 1024 },
  hosts: [],
  deleting: false,
};
let root: string;
let b: Bed;
let row: ProjectBoxRow;
let gate: BoxControlDeps["gate"];

function make() {
  const ops = { call: vi.fn(async () => ({ packages: [], error: null }) as never) };
  const images = {
    tagOf: vi.fn<(id: string, observe?: { skipped(): void }) => Promise<string>>(async () => IMAGE),
    setWanted: () => {},
    rebuild: vi.fn<(id: string, running: boolean, observe?: ImageObserver) => Promise<void>>(async () => {}),
    packages: () => ({ built: [], wanted: null }),
    forget: vi.fn(),
  };
  const recorder = recordLaunches(createLaunchRegistry({ clock: b.clock, logger: silentLogger }));
  const control = createBoxControl({
    launches: recorder.registry,
    runtime: b.runtime,
    ops: { call: ops.call, poll: ops.call } as never,
    source: () => ({ box: () => row, ownerBoxes: () => [], byPath: () => null, addHost: () => {} }),
    images,
    trash: { client: createFakeVmd(), papHome: root, clock: b.clock, logger: silentLogger },
    papHome: root,
    backend: "process",
    logger: silentLogger,
    gate: (box, launch) => gate(box, launch),
  });
  return { control, images, recorder, launches: recorder.registry };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "pap-a3-box-"));
  b = bed({ layout: () => projectLayoutOf("process", root, PROJECT_ID) });
  await b.runtime.stopAll();
  row = ROW;
  gate = async () => {};
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("launch steps (launch progress)", () => {
  it("a start reports checks, image skipped, disk, vm, guest in order and ends ok", async () => {
    const { control, images, recorder } = make();
    images.tagOf.mockImplementation(async (_id, observe) => {
      observe?.skipped();
      return IMAGE;
    });
    await control.start(PROJECT_ID);
    expect(recorder.log).toEqual([
      "checks:running",
      "checks:done",
      "image:running",
      "image:skipped",
      "disk:running",
      "disk:done",
      "vm:running",
      "vm:done",
      "guest:running",
      "guest:done",
      "end:ok",
    ]);
  });

  it("a box that already runs opens no launch", async () => {
    const { control, recorder } = make();
    await control.start(PROJECT_ID);
    const before = recorder.opened();
    await control.start(PROJECT_ID);
    expect(recorder.opened()).toBe(before);
  });

  it("a refused gate ends the launch with its code and marks checks failed", async () => {
    gate = async () => {
      throw new PapError("sandbox_unavailable");
    };
    const { control, recorder, launches } = make();
    await expect(control.start(PROJECT_ID)).rejects.toMatchObject({ code: "sandbox_unavailable" });
    expect(recorder.log).toEqual(["checks:running", "checks:failed", "end:sandbox_unavailable"]);
    expect(launches.activeFor(BOX)).toBeNull();
  });

  it("a capacity refusal ends the launch with capacity", async () => {
    const { control, recorder, launches } = make();
    row = { ...ROW, resources: { ...ROW.resources, memoryMb: 100_000 } };
    await expect(control.start(PROJECT_ID)).rejects.toMatchObject({ code: "capacity" });
    expect(recorder.log.at(-1)).toBe("end:capacity");
    expect(launches.activeFor(BOX)).toBeNull();
  });

  it("a thrown image build ends the launch with the error's code and no launch stays live", async () => {
    const { control, images, recorder, launches } = make();
    images.tagOf.mockRejectedValue(new PapError("config_invalid"));
    await expect(control.start(PROJECT_ID)).rejects.toMatchObject({ code: "config_invalid" });
    expect(recorder.log).toContain("image:failed");
    expect(recorder.log.at(-1)).toBe("end:config_invalid");
    expect(launches.activeFor(BOX)).toBeNull();
  });

  it("a plain error ends with internal", async () => {
    const { control, images, recorder } = make();
    images.tagOf.mockRejectedValue(new Error("boom"));
    await expect(control.start(PROJECT_ID)).rejects.toThrow("boom");
    expect(recorder.log.at(-1)).toBe("end:internal");
  });

  it("a box deleted while its image builds ends the launch with not_found", async () => {
    const { control, images, recorder } = make();
    images.tagOf.mockImplementation(async () => {
      row = { ...ROW, deleting: true };
      return IMAGE;
    });
    await expect(control.start(PROJECT_ID)).rejects.toMatchObject({ code: "not_found" });
    expect(recorder.log.at(-1)).toBe("end:not_found");
  });

  it("Rebuild shows the image step and ends the launch", async () => {
    const { control, images, recorder, launches } = make();
    let seen: unknown = null;
    images.rebuild.mockImplementation(async (_id, _running, observe) => {
      observe?.building("pap-agent-profile-x");
      seen = launches.activeFor(BOX);
    });
    await control.rebuild(PROJECT_ID);
    expect(recorder.log).toEqual(["image:running", "image:done", "end:ok"]);
    expect(seen).toMatchObject({ for: "rebuild", steps: [{ step: "image", state: "running" }] });
    expect(launches.activeFor(BOX)).toBeNull();
  });

  it("a failed Rebuild ends the launch with the error's code", async () => {
    const { control, images, recorder } = make();
    images.rebuild.mockRejectedValue(new PapError("config_invalid"));
    await expect(control.rebuild(PROJECT_ID)).rejects.toMatchObject({ code: "config_invalid" });
    expect(recorder.log).toEqual(["image:running", "image:failed", "end:config_invalid"]);
  });

  it("a rebuild launch does not mark the box starting", async () => {
    const { control, images } = make();
    let phase: unknown = null;
    images.rebuild.mockImplementation(async () => {
      phase = control.phase(PROJECT_ID);
    });
    await control.rebuild(PROJECT_ID);
    expect(phase).toBe("stopped");
  });

  it("a session that joins a rebuild launch turns it into a box launch", async () => {
    const { control, launches } = make();
    launches.open({ box: BOX, owner: "owner", for: "rebuild" });
    expect(control.phase(PROJECT_ID)).toBe("stopped");
    launches.open({ box: BOX, owner: "owner", for: "session-1" });
    expect(launches.activeFor(BOX)?.for).toBe("session-1");
    expect(control.phase(PROJECT_ID)).toBe("starting");
  });
});
