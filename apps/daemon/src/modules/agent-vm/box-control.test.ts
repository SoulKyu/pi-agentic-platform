import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BoxPhase, DEFAULT_AGENT_RESOURCES, PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoxOps, ProjectBoxRow } from "../../kernel/boxes.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { type BoxControlDeps, createBoxControl, createBoxOps, type ProjectImages } from "./index.ts";
import { CRASH_LIMIT } from "./lifecycle.ts";
import { projectLayoutOf } from "./project-layout.ts";
import {
  bed,
  IDLE_MS,
  IMAGE,
  PROJECT_ID,
  settle,
  specOf,
  workerInput,
  type Bed,
} from "./runtime-fixtures.ts";
import { createFakeVmd, type FakeVmd } from "./testing/fake-vmd.ts";

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
let fake: FakeVmd;
let row: ProjectBoxRow | null;
let config: { packages: string[] | null; error: string | null } | Error;
let wanted: Array<readonly string[]>;
let gate: BoxControlDeps["gate"];
let phases: BoxPhase[];

function make(client: FakeVmd = fake) {
  const answer = vi.fn(async () => {
    if (config instanceof Error) throw config;
    return config as never;
  });
  const ops: BoxOps = { call: answer, poll: answer };
  const images = {
    tagOf: vi.fn(async () => IMAGE),
    setWanted: (_id: string, packages: readonly string[]) => void wanted.push(packages),
    rebuild: vi.fn<(id: string, running: boolean) => Promise<void>>(async () => {}),
    packages: () => ({ built: [], wanted: null }),
    forget: vi.fn(),
  } satisfies ProjectImages;
  const control = createBoxControl({
    runtime: b.runtime,
    ops,
    source: () => ({ box: () => row, ownerBoxes: () => [], byPath: () => null, addHost: () => {} }),
    images,
    trash: { client, papHome: root, clock: b.clock, logger: silentLogger },
    papHome: root,
    backend: "process",
    logger: silentLogger,
    gate: (box) => gate(box),
  });
  control.onPhase((_id, phase) => void phases.push(phase));
  return { control, images, ops };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "pap-a6-box-"));
  b = bed({ layout: () => projectLayoutOf("process", root, PROJECT_ID) });
  await b.runtime.stopAll();
  fake = createFakeVmd();
  row = ROW;
  config = { packages: ["jq"], error: null };
  wanted = [];
  gate = async () => {};
  phases = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("stop (M14: a disabled owner's boxes)", () => {
  it("stops a running box and leaves its row, a stopped box is a no-op, and a restart after it is the gate's call", async () => {
    const { control } = make();
    await control.start(PROJECT_ID);
    await control.stop(PROJECT_ID);
    expect(control.phase(PROJECT_ID)).toBe("stopped");
    await expect(control.stop(PROJECT_ID)).resolves.toBeUndefined();
    gate = async () => {
      throw new PapError("account_disabled");
    };
    await expect(control.start(PROJECT_ID)).rejects.toMatchObject({ code: "account_disabled" });
    await expect(control.restart(PROJECT_ID)).rejects.toMatchObject({ code: "account_disabled" });
    expect(control.phase(PROJECT_ID)).toBe("stopped");
    expect(b.starts).toHaveLength(1);
  });

  it("a start queued behind a stop meets the gate, so a disable between the two wins", async () => {
    const { control } = make();
    await control.start(PROJECT_ID);
    const stopping = control.stop(PROJECT_ID);
    gate = async () => {
      throw new PapError("account_disabled");
    };
    const starting = control.start(PROJECT_ID);
    await stopping;
    await expect(starting).rejects.toMatchObject({ code: "account_disabled" });
    expect(control.phase(PROJECT_ID)).toBe("stopped");
  });
});

describe("start", () => {
  it("brings a box up without a worker", async () => {
    const { control, images } = make();
    await control.start(PROJECT_ID);
    expect(control.phase(PROJECT_ID)).toBe("running");
    expect(b.starts).toHaveLength(1);
    expect(b.starts[0]?.spec).toMatchObject({
      box: BOX,
      kind: "thread",
      image: IMAGE,
      resources: ROW.resources,
    });
    expect(b.guestAt(0).spawned).toEqual([]);
    expect(images.tagOf).toHaveBeenCalledWith(PROJECT_ID);
    expect(wanted).toEqual([["jq"]]);
  });

  it("is one launch for two calls, and nothing for a box that runs", async () => {
    const { control } = make();
    await Promise.all([control.start(PROJECT_ID), control.start(PROJECT_ID)]);
    await control.start(PROJECT_ID);
    expect(b.starts).toHaveLength(1);
  });

  it("answers the refusals of a launch and never starts the VM", async () => {
    const { control } = make();
    gate = async () => {
      throw new PapError("vm_bundle_stale");
    };
    await expect(control.start(PROJECT_ID)).rejects.toMatchObject({ code: "vm_bundle_stale" });
    expect(b.starts).toHaveLength(0);
    expect(control.phase(PROJECT_ID)).toBe("stopped");
    gate = async () => {};
    row = { ...ROW, resources: { ...ROW.resources, memoryMb: 100_000 } };
    await expect(control.start(PROJECT_ID)).rejects.toMatchObject({ code: "capacity" });
    row = null;
    await expect(control.start(PROJECT_ID)).rejects.toMatchObject({ code: "not_found" });
    row = { ...ROW, deleting: true };
    await expect(control.start(PROJECT_ID)).rejects.toMatchObject({ code: "not_found" });
  });

  it("never stops another box to make room", async () => {
    const { control } = make();
    await b.runtime.spawn(
      specOf("scout-0001", { resources: { ...ROW.resources, memoryMb: 3000 } }),
      workerInput(),
      null,
    );
    await expect(control.start(PROJECT_ID)).rejects.toMatchObject({ code: "capacity" });
    expect(b.runtime.phase({ kind: "agent", id: "scout-0001" })).toBe("running");
  });

  it("keeps the packages it knew when the config cannot be read", async () => {
    const { control } = make();
    config = { packages: null, error: "bad_packages" };
    await control.start(PROJECT_ID);
    expect(wanted).toEqual([]);
    expect(control.phase(PROJECT_ID)).toBe("running");
  });
});

describe("restart", () => {
  it("is a new launch", async () => {
    const { control } = make();
    await control.start(PROJECT_ID);
    const first = b.launchAt(0).launchId;
    await control.restart(PROJECT_ID);
    expect(b.starts).toHaveLength(2);
    expect(b.launchAt(1).launchId).not.toBe(first);
    expect(b.ended).toContain(first);
    expect(control.phase(PROJECT_ID)).toBe("running");
  });

  it("resumes a box the crash pause refused", async () => {
    const { control } = make();
    const spec = specOf("unused", { box: BOX });
    for (let i = 0; i < CRASH_LIMIT; i++) {
      await b.runtime.spawn(spec, workerInput(), null);
      b.guestAt(-1).crash();
      await settle();
    }
    await expect(control.start(PROJECT_ID)).rejects.toMatchObject({ code: "agent_paused" });
    await control.restart(PROJECT_ID);
    expect(control.phase(PROJECT_ID)).toBe("running");
  });
});

describe("dispose and purge", () => {
  const mirrors = () => join(root, "boxes", ".mirrors", PROJECT_ID);
  const trashed = () => join(root, "boxes", ".trash", `${PROJECT_ID}-1760000000000.mirrors`);

  it("dispose trashes the disk and the mirrors", async () => {
    const { control, images } = make();
    fake.disks.set(`project:${PROJECT_ID}`, 8192);
    mkdirSync(mirrors(), { recursive: true });
    writeFileSync(join(mirrors(), "s.jsonl"), "line\n");
    await control.start(PROJECT_ID);
    await control.dispose(PROJECT_ID, 1_760_000_000_000);
    expect(control.phase(PROJECT_ID)).toBe("stopped");
    expect(b.ended).toHaveLength(1);
    expect(fake.of("disk.delete")).toEqual([{ op: "disk.delete", box: BOX, taskKey: null, purge: false }]);
    expect(existsSync(mirrors())).toBe(false);
    expect(existsSync(join(trashed(), "s.jsonl"))).toBe(true);
    expect(images.forget).toHaveBeenCalledWith(PROJECT_ID);

    await control.purge(PROJECT_ID);
    expect(fake.of("trash.purge")).toEqual([{ op: "trash.purge", box: BOX }]);
    expect(existsSync(trashed())).toBe(false);
  });
});

describe("idle stop", () => {
  it("waits for no worker and no op", async () => {
    const { control } = make();
    await control.start(PROJECT_ID);
    await b.clock.advance(IDLE_MS - 1);
    b.runtime.touch(BOX); // an op: the wait starts again
    await b.clock.advance(IDLE_MS - 1);
    expect(control.phase(PROJECT_ID)).toBe("running");

    await b.runtime.spawn(specOf("unused", { box: BOX }), workerInput(), null);
    await b.clock.advance(IDLE_MS * 2);
    expect(control.phase(PROJECT_ID)).toBe("running"); // a worker keeps it
    b.guestAt(0).handles[0]?.end();
    await settle();
    await b.clock.advance(IDLE_MS - 1);
    expect(control.phase(PROJECT_ID)).toBe("running");
    await b.clock.advance(1);
    await settle();
    expect(control.phase(PROJECT_ID)).toBe("stopped");
  });

  it("a box with PAP_WORKER_IDLE_MINUTES=0 never stops", async () => {
    b = bed({ layout: () => projectLayoutOf("process", root, PROJECT_ID), idleMs: 0 });
    await b.runtime.stopAll();
    const { control } = make();
    await control.start(PROJECT_ID);
    await b.clock.advance(IDLE_MS * 100);
    expect(control.phase(PROJECT_ID)).toBe("running");
  });
});

describe("onPhase", () => {
  it("reports each phase once", async () => {
    const { control } = make();
    await control.start(PROJECT_ID);
    await control.start(PROJECT_ID);
    expect(phases).toEqual(["starting", "running"]);
    b.guestAt(0).crash(); // the VM dies
    await settle();
    expect(phases).toEqual(["starting", "running", "stopped"]);
    await b.clock.advance(IDLE_MS);
    await control.restart(PROJECT_ID);
    expect(phases).toEqual(["starting", "running", "stopped", "starting", "running"]);
    await b.clock.advance(IDLE_MS); // the idle stop
    await settle();
    expect(phases.slice(-1)).toEqual(["stopped"]);
  });

  it("reports a start that failed, and a launch that no control asked for", async () => {
    const { control } = make();
    gate = async () => {
      throw new PapError("sandbox_unavailable");
    };
    await expect(control.start(PROJECT_ID)).rejects.toThrow();
    expect(phases).toEqual(["starting", "stopped"]);
    phases.length = 0;
    await b.runtime.spawn(specOf("unused", { box: BOX }), workerInput(), null);
    expect(phases).toEqual(["starting", "running"]);
  });
});

describe("rootOf and packages", () => {
  it("rootOf is the project folder of the layout, and rebuild goes to the images", async () => {
    const { control, images } = make();
    expect(control.rootOf(PROJECT_ID)).toBe(projectLayoutOf("process", root, PROJECT_ID).project);
    await control.rebuild(PROJECT_ID);
    expect(images.rebuild).toHaveBeenCalledWith(PROJECT_ID, false);
    expect(control.packages(PROJECT_ID)).toEqual({ built: [], wanted: null });
  });
});

describe("a poll never keeps a box alive", () => {
  const stoppedAfterIdle = async (use: "call" | "poll") => {
    const { control } = make();
    const ops = createBoxOps(b.runtime, b.clock);
    await control.start(PROJECT_ID);
    await b.clock.advance(IDLE_MS - 1);
    await ops[use](PROJECT_ID, { name: "project.config" }).catch(() => {}); // the fake guest answers nothing
    await b.clock.advance(1);
    await settle();
    return control.phase(PROJECT_ID) === "stopped";
  };

  it("a poll does not delay the idle stop", async () => {
    expect(await stoppedAfterIdle("poll")).toBe(true);
  });

  it("a call does", async () => {
    expect(await stoppedAfterIdle("call")).toBe(false);
  });
});

describe("dispose is ordered", () => {
  it("a restart and a session spawn racing a dispose both end refused, and the disk goes after the VM stops", async () => {
    const order = b.order;
    const seen: FakeVmd = Object.create(fake, {
      request: { value: async (r: Parameters<FakeVmd["request"]>[0]) => (order.push(r.op), fake.request(r)) },
    });
    fake.disks.set(`project:${PROJECT_ID}`, 8192);
    const { control: again } = make(seen);
    await again.start(PROJECT_ID);
    const disposing = again.dispose(PROJECT_ID, 1_760_000_000_000);
    const restarting = again.restart(PROJECT_ID);
    const spawning = b.runtime.spawn(specOf("unused", { box: BOX }), workerInput(), null);
    await expect(restarting).rejects.toMatchObject({ code: "not_found" });
    await expect(spawning).rejects.toMatchObject({ code: "not_found" });
    await disposing;
    expect(b.starts).toHaveLength(1);
    expect(order.indexOf(`stop:${PROJECT_ID}:`)).toBeGreaterThan(-1);
    expect(order.indexOf("disk.delete")).toBeGreaterThan(order.indexOf(`stop:${PROJECT_ID}:`));
    expect(again.phase(PROJECT_ID)).toBe("stopped");
    await again.purge(PROJECT_ID); // purge opens the runtime again
  });
});
