import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AGENT_RESOURCES, type BoxOpValue } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoxOps, ProjectBoxRow } from "../../kernel/boxes.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createBoxControl, createLaunchRegistry, type ProjectImages } from "./index.ts";
import { projectLayoutOf } from "./project-layout.ts";
import { bed, IMAGE, PROJECT_ID, type Bed } from "./runtime-fixtures.ts";
import { createFakeVmd } from "./testing/fake-vmd.ts";

// UX2-R73: what `project.config` says of the preview is recorded whatever it says of the packages.
const ROW: ProjectBoxRow = {
  ownerId: "owner",
  root: "/boxes/x/project",
  resources: { ...DEFAULT_AGENT_RESOURCES, memoryMb: 1024 },
  hosts: [],
  deleting: false,
};
let root: string;
let b: Bed;
let config: Partial<BoxOpValue<"project.config">>;
let wanted: Array<readonly string[]>;

let polled: ReturnType<typeof vi.fn>;
let called: ReturnType<typeof vi.fn>;

function make() {
  called = vi.fn(async () => config as never);
  polled = vi.fn(async () => config as never);
  const ops: BoxOps = { call: called as BoxOps["call"], poll: polled as BoxOps["poll"] };
  const images = {
    tagOf: vi.fn(async () => IMAGE),
    setWanted: (_id: string, packages: readonly string[]) => void wanted.push(packages),
    rebuild: vi.fn<(id: string, running: boolean, observe?: unknown) => Promise<void>>(async () => {}),
    packages: () => ({ built: [], wanted: null }),
    forget: vi.fn(),
  } satisfies ProjectImages;
  return createBoxControl({
    launches: createLaunchRegistry({ clock: b.clock, logger: silentLogger }),
    runtime: b.runtime,
    ops,
    source: () => ({ box: () => ROW, ownerBoxes: () => [], byPath: () => null, addHost: () => {} }),
    images,
    trash: { client: createFakeVmd(), papHome: root, clock: b.clock, logger: silentLogger },
    papHome: root,
    backend: "process",
    logger: silentLogger,
    gate: async () => {},
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "pap-ux2-box-"));
  b = bed({ layout: () => projectLayoutOf("process", root, PROJECT_ID) });
  await b.runtime.stopAll();
  wanted = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the preview of .pi/project.yaml, read when the box comes up", () => {
  it("a project file with a preview and no packages records its preview", async () => {
    config = {
      packages: null,
      error: null,
      preview: { command: "npm run dev", port: 5173 },
      previewInvalid: false,
    };
    const control = make();
    expect(control.preview(PROJECT_ID)).toEqual({ decl: null, invalid: false });
    await control.start(PROJECT_ID);
    expect(control.preview(PROJECT_ID)).toEqual({
      decl: { command: "npm run dev", port: 5173 },
      invalid: false,
    });
    expect(wanted).toEqual([]);
  });

  it("an invalid preview records previewInvalid and leaves packages as they were", async () => {
    config = { packages: ["jq"], error: null, preview: null, previewInvalid: true };
    const control = make();
    await control.start(PROJECT_ID);
    expect(control.preview(PROJECT_ID)).toEqual({ decl: null, invalid: true });
    expect(wanted).toEqual([["jq"]]);
  });

  it("a file without preview records null, and a later edit replaces what was recorded", async () => {
    config = {
      packages: ["jq"],
      error: null,
      preview: { command: "serve", port: 4000 },
      previewInvalid: false,
    };
    const control = make();
    await control.start(PROJECT_ID);
    expect(control.preview(PROJECT_ID).decl).toEqual({ command: "serve", port: 4000 });
    config = { packages: ["jq"], error: null, preview: null, previewInvalid: false };
    await control.rebuild(PROJECT_ID);
    expect(control.preview(PROJECT_ID)).toEqual({ decl: null, invalid: false });
  });
});

describe("the preview cache follows the file, not only the control's own starts (final review I1)", () => {
  it("a box that a session's launch starts records the preview, read with poll and never with call", async () => {
    config = {
      packages: null,
      error: null,
      preview: { command: "serve", port: 4000 },
      previewInvalid: false,
    };
    const control = make();
    await b.runtime.start({
      box: { kind: "project", id: PROJECT_ID },
      kind: "thread",
      taskKey: null,
      image: IMAGE,
      resources: ROW.resources,
    });
    await vi.waitFor(() =>
      expect(control.preview(PROJECT_ID).decl).toEqual({ command: "serve", port: 4000 }),
    );
    expect(polled).toHaveBeenCalledWith(PROJECT_ID, { name: "project.config" });
    expect(called).not.toHaveBeenCalled();
  });

  it("notePreview replaces what the cache held", () => {
    const control = make();
    control.notePreview(PROJECT_ID, { command: "new", port: 3000 }, false);
    expect(control.preview(PROJECT_ID)).toEqual({ decl: { command: "new", port: 3000 }, invalid: false });
    control.notePreview(PROJECT_ID, null, true);
    expect(control.preview(PROJECT_ID)).toEqual({ decl: null, invalid: true });
  });
});
