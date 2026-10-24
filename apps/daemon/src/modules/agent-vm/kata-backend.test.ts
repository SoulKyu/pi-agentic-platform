import { type BoxRef, DEFAULT_AGENT_RESOURCES } from "@pap/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { createKataBackend, GROW_NOTICE } from "./kata-backend.ts";
import type { AgentRuntimeBackend, VmSpec } from "./runtime.ts";
import { createFakeVmd, type FakeVmd } from "./testing/fake-vmd.ts";
import { VmdError } from "./vmd-client.ts";

/*
 * Mutants (RT-43), run for real in the T15a report: "disk ops for a task" (the isolated cases),
 * "grow always" / "grow never" (the grow cases), "grow conflict thrown" (the notice case), "stop by key"
 * (the late-stop cases), "known size not kept" (the second start), "list drops stopped VMs" (the list case), "error text
 * carries the request" (the token case), "current launch set after the await" (the queued case).
 */
const IMAGE = `pap-agent-agent-${"a".repeat(64)}`;
const TASK = "c".repeat(32);
const SCOUT: BoxRef = { kind: "agent", id: "scout-0001" };
const PROJECT: BoxRef = { kind: "project", id: "0b1c2d3e-4f50-4162-8394-a5b6c7d8e9f0" };
const TOKEN = "ab".repeat(32);
let fake: FakeVmd;
let notices: Array<[string, string]>;
const images = { started: vi.fn(), stopped: vi.fn() };
let backend: AgentRuntimeBackend;

const spec = (extra: Partial<VmSpec> = {}): VmSpec => ({
  box: SCOUT,
  kind: "thread",
  taskKey: null,
  image: IMAGE,
  resources: DEFAULT_AGENT_RESOURCES,
  ...extra,
});
const task = (): VmSpec => spec({ kind: "isolated", taskKey: TASK });
let counter = 0;
const launch = () => {
  counter += 1;
  return { launchId: counter.toString(16).padStart(32, "0"), token: TOKEN };
};

beforeEach(() => {
  fake = createFakeVmd();
  notices = [];
  images.started.mockClear();
  images.stopped.mockClear();
  backend = createKataBackend({
    client: fake,
    images,
    logger: silentLogger,
    notice: (agentId, text) => void notices.push([agentId, text]),
  });
});

describe("a first start", () => {
  it("creates the agent's disk, then starts the VM with the launch and the resources", async () => {
    const l = launch();
    await expect(backend.start(spec(), l)).resolves.toEqual({ address: fake.address });
    expect(fake.ops()).toEqual(["disk.create", "vm.start"]);
    expect(fake.of("disk.create")[0]).toEqual({
      op: "disk.create",
      box: SCOUT,
      taskKey: null,
      diskMb: DEFAULT_AGENT_RESOURCES.diskMb,
    });
    expect(fake.of("vm.start")[0]).toEqual({
      op: "vm.start",
      box: SCOUT,
      kind: "thread",
      taskKey: null,
      image: IMAGE,
      resources: DEFAULT_AGENT_RESOURCES,
      launchId: l.launchId,
      token: TOKEN,
    });
    expect(images.started).toHaveBeenCalledWith("scout-0001", IMAGE);
  });

  it("starts the VM of an agent whose disk pap-vmd already holds, growing it to the profile's size", async () => {
    fake.disks.set("agent:scout-0001", 1024);
    await backend.start(spec(), launch());
    expect(fake.ops()).toEqual(["disk.create", "disk.grow", "vm.start"]);
    expect(fake.disks.get("agent:scout-0001")).toBe(DEFAULT_AGENT_RESOURCES.diskMb);
  });
});

describe("the next starts", () => {
  it("make no disk call when the size has not changed", async () => {
    await backend.start(spec(), launch());
    await backend.stop(SCOUT, null);
    fake.requests.length = 0;
    await backend.start(spec(), launch());
    expect(fake.ops()).toEqual(["vm.start"]);
  });

  it("grow the disk when the profile's size grew", async () => {
    await backend.start(spec(), launch());
    await backend.stop(SCOUT, null);
    fake.requests.length = 0;
    const bigger = { ...DEFAULT_AGENT_RESOURCES, diskMb: DEFAULT_AGENT_RESOURCES.diskMb * 2 };
    await backend.start(spec({ resources: bigger }), launch());
    expect(fake.ops()).toEqual(["disk.grow", "vm.start"]);
    expect(fake.of("disk.grow")[0]).toMatchObject({ diskMb: bigger.diskMb, taskKey: null });
  });

  it("start without growing, with a notice, while another VM of the agent runs; the next start grows", async () => {
    await backend.start(spec(), launch());
    await backend.stop(SCOUT, null);
    await backend.start(task(), launch());
    const bigger = { ...DEFAULT_AGENT_RESOURCES, diskMb: DEFAULT_AGENT_RESOURCES.diskMb * 2 };
    await expect(backend.start(spec({ resources: bigger }), launch())).resolves.toBeDefined();
    expect(fake.of("disk.grow")).toHaveLength(1);
    expect(fake.running.has("agent:scout-0001")).toBe(true);
    expect(notices).toEqual([["scout-0001", GROW_NOTICE]]);
    await backend.stop(SCOUT, null);
    await backend.stop(SCOUT, TASK);
    await backend.start(spec({ resources: bigger }), launch());
    expect(fake.of("disk.grow")).toHaveLength(2);
    expect(fake.disks.get("agent:scout-0001")).toBe(bigger.diskMb);
    expect(notices).toHaveLength(1);
  });

  it("do not ask again for a size below the file's: pap-vmd refuses a shrink and the start goes on", async () => {
    fake.disks.set("agent:scout-0001", 20_000);
    await backend.start(spec(), launch());
    expect(fake.ops()).toEqual(["disk.create", "disk.grow", "vm.start"]);
    await backend.stop(SCOUT, null);
    fake.requests.length = 0;
    await backend.start(spec(), launch());
    expect(fake.ops()).toEqual(["vm.start"]);
  });

  it("forgets what it knew of a disk pap-vmd no longer holds, and makes it again at the next start", async () => {
    await backend.start(spec(), launch());
    await backend.stop(SCOUT, null);
    fake.disks.delete("agent:scout-0001");
    await expect(backend.start(spec(), launch())).rejects.toMatchObject({ code: "not_found" });
    fake.requests.length = 0;
    await backend.start(spec(), launch());
    expect(fake.ops()).toEqual(["disk.create", "vm.start"]);
  });

  it("a disk error other than a conflict fails the start before any VM starts", async () => {
    fake.failNext("disk.create", "disk_low");
    await expect(backend.start(spec(), launch())).rejects.toMatchObject({ code: "disk_low" });
    expect(fake.ops()).toEqual(["disk.create"]);
    expect(images.started).not.toHaveBeenCalled();
  });
});

describe("an isolated task (R30, Review Focus 4)", () => {
  it("names only vm ops with its task key, at start and at stop", async () => {
    await backend.start(task(), launch());
    await backend.stop(SCOUT, TASK);
    expect(fake.ops()).toEqual(["vm.start", "vm.stop"]);
    expect(fake.of("vm.start")[0]).toMatchObject({ kind: "isolated", taskKey: TASK });
    expect(fake.of("vm.stop")[0]).toMatchObject({ taskKey: TASK });
    expect(images.started).not.toHaveBeenCalled();
    expect(images.stopped).not.toHaveBeenCalled();
  });

  it("names no disk op when the start fails, or when the stop fails, or when the agent has no disk", async () => {
    fake.failNext("vm.start", "capacity");
    await expect(backend.start(task(), launch())).rejects.toMatchObject({ code: "capacity" });
    await backend.start(task(), launch());
    fake.failNext("vm.stop", "failed");
    await expect(backend.stop(SCOUT, TASK)).rejects.toMatchObject({ code: "worker_failed" });
    expect(fake.ops().filter((op) => op.startsWith("disk."))).toEqual([]);
  });
});

describe("a stop names its launch", () => {
  it("stops the VM of the current launch and forgets it", async () => {
    const l = launch();
    await backend.start(spec(), l);
    await backend.stop(SCOUT, null, l.launchId);
    expect(fake.of("vm.stop")).toHaveLength(1);
    expect(images.stopped).toHaveBeenCalledWith("scout-0001");
    expect(fake.running.size).toBe(0);
  });

  it("ignores a stop for a launch that is no longer the VM's (a late stop never hits a fresh VM)", async () => {
    const old = launch();
    await backend.start(spec(), old);
    await backend.stop(SCOUT, null, old.launchId);
    const fresh = launch();
    await backend.start(spec(), fresh);
    await backend.stop(SCOUT, null, old.launchId);
    expect(fake.of("vm.stop")).toHaveLength(1);
    expect(fake.running.has("agent:scout-0001")).toBe(true);
    await backend.stop(SCOUT, null, fresh.launchId);
    expect(fake.running.has("agent:scout-0001")).toBe(false);
  });

  it("serves a start, its stop, a second stop of it and the next start of one key in order", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = launch();
    const second = launch();
    fake.handle("vm.start", async (request) => {
      if (request.op === "vm.start" && request.launchId === first.launchId) await held;
      fake.running.add("agent:scout-0001");
      return { address: fake.address };
    });
    const starting = backend.start(spec(), first);
    const stopping = backend.stop(SCOUT, null, first.launchId);
    const lateStop = backend.stop(SCOUT, null, first.launchId);
    const next = backend.start(spec(), second);
    release();
    await Promise.all([starting, stopping, lateStop, next]);
    // The second stop found its launch gone; the fresh VM is the one left running.
    expect(fake.ops().filter((op) => op.startsWith("vm."))).toEqual(["vm.start", "vm.stop", "vm.start"]);
    expect(fake.running.has("agent:scout-0001")).toBe(true);
  });

  it("stops unconditionally when no launch is named (the boot's sweep)", async () => {
    await backend.start(spec(), launch());
    await backend.stop(SCOUT, null);
    expect(fake.running.size).toBe(0);
  });
});

describe("a start that fails (I2)", () => {
  // pap-vmd may have made the VM before the answer was lost (a timeout, an unparseable answer): the cleanup stop must go out.
  const lose = (code: "timeout" | "protocol" | "failed") =>
    fake.handle("vm.start", (request) => {
      if (request.op === "vm.start") fake.running.add("agent:scout-0001");
      throw new VmdError(code);
    });

  it.each(["timeout", "protocol", "failed"] as const)(
    "a %s on vm.start is followed by its cleanup stop",
    async (code) => {
      lose(code);
      const l = launch();
      await expect(backend.start(spec(), l)).rejects.toBeDefined();
      await backend.stop(SCOUT, null, l.launchId);
      expect(fake.of("vm.stop")).toHaveLength(1);
      expect(fake.running.size).toBe(0);
    },
  );

  it("a fresh start after it replaces it: the late cleanup stop does not reach the fresh VM", async () => {
    lose("timeout");
    const failed = launch();
    await backend.start(spec(), failed).catch(() => {});
    fake.handle("vm.start", () => (fake.running.add("agent:scout-0001"), { address: fake.address }));
    const fresh = launch();
    await backend.start(spec(), fresh);
    await backend.stop(SCOUT, null, failed.launchId);
    expect(fake.of("vm.stop")).toEqual([]);
    expect(fake.running.has("agent:scout-0001")).toBe(true);
  });
});

describe("the grow notice (M7)", () => {
  it("is not posted after a restart when the size never changed: create and grow both answer conflict", async () => {
    fake.disks.set("agent:scout-0001", DEFAULT_AGENT_RESOURCES.diskMb);
    await backend.start(task(), launch());
    await backend.start(spec(), launch());
    expect(fake.ops()).toEqual(["vm.start", "disk.create", "disk.grow", "vm.start"]);
    expect(notices).toEqual([]);
  });
});

describe("a project box", () => {
  it("starts a project box with its box ref", async () => {
    const l = launch();
    await expect(backend.start(spec({ box: PROJECT }), l)).resolves.toEqual({ address: fake.address });
    expect(fake.ops()).toEqual(["disk.create", "vm.start"]);
    expect(fake.of("disk.create")[0]).toMatchObject({ box: PROJECT, taskKey: null });
    expect(fake.of("vm.start")[0]).toMatchObject({ box: PROJECT, kind: "thread", taskKey: null });
    expect(fake.disks.has(`project:${PROJECT.id}`)).toBe(true);
    expect(fake.running.has(`project:${PROJECT.id}`)).toBe(true);
    expect(images.started).toHaveBeenCalledWith(PROJECT.id, spec().image); // the project layer builds behind a running box
    await expect(backend.list()).resolves.toEqual([{ box: PROJECT, taskKey: null }]);
    await backend.stop(PROJECT, null);
    expect(images.stopped).toHaveBeenCalledWith(PROJECT.id);
    expect(fake.running.size).toBe(0);
  });

  it("keeps a project box and an agent box apart, in disks and in order", async () => {
    await backend.start(spec({ box: PROJECT }), launch());
    await backend.start(spec(), launch());
    expect([...fake.disks.keys()].sort()).toEqual([`agent:scout-0001`, `project:${PROJECT.id}`]);
    await backend.stop(SCOUT, null);
    expect([...fake.running]).toEqual([`project:${PROJECT.id}`]);
    expect(notices).toEqual([]);
  });
});

describe("list and errors", () => {
  it("lists every VM pap-vmd holds, a stopped one too (the boot removes them all)", async () => {
    fake.handle("vm.list", () => ({
      vms: [
        { box: { kind: "agent", id: "a-0001" }, taskKey: null, state: "running" },
        { box: { kind: "agent", id: "b-0002" }, taskKey: TASK, state: "stopped" },
      ],
    }));
    await expect(backend.list()).resolves.toEqual([
      { box: { kind: "agent", id: "a-0001" }, taskKey: null },
      { box: { kind: "agent", id: "b-0002" }, taskKey: TASK },
    ]);
  });

  it("answers an unreadable listing as sandbox_unavailable", async () => {
    fake.handle("vm.list", () => ({ vms: "no" }));
    await expect(backend.list()).rejects.toMatchObject({ code: "sandbox_unavailable" });
  });

  it("never lets the launch token into an error", async () => {
    fake.failNext("vm.start", "failed");
    const error = await backend.start(spec(), launch()).then(
      () => null,
      (caught: Error) => caught,
    );
    expect(String(error?.message) + String(error?.stack)).not.toContain(TOKEN);
  });
});
