import { DEFAULT_PROJECT_RESOURCES, type InitRecord, PolicyRules, type VmLayout } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { createFakeWorker } from "../../kernel/testing/fake-worker.ts";
import { projectLayoutOf, type VmSpec } from "../agent-vm/index.ts";
import type { AgentLaunch } from "./agent-gate.ts";
import type { ProjectLaunch } from "./project-gate.ts";
import type { SessionRow } from "./store.ts";
import { codeOf } from "./testing/helpers.ts";
import { createVmLaunch } from "./vm-launch.ts";

const PROJECT = "6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d11";
const HOME = "/pap";
const IMAGE = `pap-agent-agent-${"c".repeat(64)}`;
const layout: VmLayout = projectLayoutOf("process", HOME, PROJECT);
const row = (extra: Partial<SessionRow> = {}): SessionRow =>
  ({ id: "s1", ownerId: "u1", cwd: layout.project, piPath: null, ...extra }) as SessionRow;
const launch = (extra: Partial<ProjectLaunch> = {}): ProjectLaunch => ({
  project: { id: PROJECT },
  resources: { memoryMb: 1024, cpus: 1, diskMb: 4096 },
  scope: layout.project ?? "",
  home: layout.home,
  vm: true,
  ...extra,
});
const hostInit = (r: SessionRow): InitRecord => ({
  type: "init",
  cwd: r.cwd,
  agentDir: "/host/pi",
  papHome: HOME,
  umask: 0o022,
  papSessionId: r.id,
  policy: PolicyRules.parse({
    profile: "project",
    approvalMode: "supervised",
    agentHome: layout.project,
    sandbox: { required: true, network: true },
  }),
});

function setup(over: { imageTagOf?: (id: string) => string; recheck?: () => void } = {}) {
  const specs: VmSpec[] = [];
  const packages: unknown[] = [];
  const mirrorRows: unknown[] = [];
  const mirrorResources: unknown[] = [];
  const joined: Array<[string, string]> = [];
  const spawn = vi.fn(async (spec: VmSpec, _worker: unknown, picks: unknown) => {
    specs.push(spec);
    packages.push(picks);
    return {
      handle: Object.assign(createFakeWorker({}), { slot: "b".repeat(32), piFile: () => null }),
      layout,
      relayKey: "a".repeat(64),
      slot: "b".repeat(32),
      launchId: "launch-1",
    };
  });
  const toImageEntries = vi.fn();
  const vmLaunch = createVmLaunch({
    runtime: { spawn } as never,
    papHome: HOME,
    layoutOf: (r) => (r.agentId === undefined ? layout : null),
    joinLaunch: (launchId, sessionId) => void joined.push([launchId, sessionId]),
    imageTagOf: () => {
      throw new Error("an agent's image is not a box's");
    },
    ...(over.imageTagOf ? { projectImageTagOf: over.imageTagOf } : { projectImageTagOf: () => IMAGE }),
    ...(over.recheck ? { recheckProject: over.recheck } : {}),
    mirrors: {
      inputFor: (r, resources) => {
        mirrorRows.push(r);
        mirrorResources.push(resources);
        return {
          sessionFile: null,
          sessionsDir: "/ignored",
          mirrorFor: () => "refused" as const,
          unsent: () => false,
          sent: () => {},
        };
      },
    },
    logger: silentLogger,
    packageSources: async () => {
      throw new Error("a box has no agent picks");
    },
    toImageEntries,
  });
  return { vmLaunch, specs, packages, mirrorRows, mirrorResources, joined, toImageEntries, spawn };
}

describe("a project row in its box", () => {
  it("launches a project row in its project box", async () => {
    const bed = setup();
    const r = row();
    const started = await bed.vmLaunch.spawn(r, launch(), hostInit(r));
    expect(bed.specs).toEqual([
      {
        box: { kind: "project", id: PROJECT },
        kind: "thread",
        taskKey: null,
        image: IMAGE,
        resources: { memoryMb: 1024, cpus: 1, diskMb: 4096 },
      },
    ]);
    // A box's packages are its image's: nothing is mapped through an agent's picks.
    expect(bed.packages).toEqual([null]);
    expect(bed.toImageEntries).not.toHaveBeenCalled();
    expect(bed.joined).toEqual([["launch-1", "s1"]]);
    const out = started.bind(() => ({ init: hostInit(r) }));
    expect(out.init.cwd).toBe(layout.project);
    expect(out.init.knowledge).toEqual({ path: `${layout.project}/knowledge` });
    expect(out.init.vm).toMatchObject({ layout, relayKey: "a".repeat(64) });
  });

  it("a task row of a project box uses the same box", async () => {
    const bed = setup();
    const task = row({ id: "0f6c0f2e-1111-4222-8333-444455556666", agentRole: undefined });
    await bed.vmLaunch.spawn(row(), launch(), hostInit(row()));
    await bed.vmLaunch.spawn(task, launch(), hostInit(task));
    expect(bed.specs.map((spec) => [spec.box, spec.kind, spec.taskKey])).toEqual([
      [{ kind: "project", id: PROJECT }, "thread", null],
      [{ kind: "project", id: PROJECT }, "thread", null],
    ]);
  });

  it("hands the mirrors the project and its disk as the quota", async () => {
    const bed = setup();
    const r = row();
    await bed.vmLaunch.spawn(r, launch({ resources: DEFAULT_PROJECT_RESOURCES }), hostInit(r));
    expect(bed.mirrorRows).toEqual([expect.objectContaining({ id: "s1", projectId: PROJECT })]);
    expect(bed.mirrorResources).toEqual([DEFAULT_PROJECT_RESOURCES]);
  });

  it("asks for the project's image, and rechecks the project just before the VM starts", async () => {
    const order: string[] = [];
    const bed = setup({
      imageTagOf: (id) => (order.push(`image:${id}`), IMAGE),
      recheck: () => void order.push("recheck"),
    });
    bed.spawn.mockImplementationOnce(async (spec) => {
      order.push("spawn");
      return {
        handle: createFakeWorker({}),
        layout,
        relayKey: "a".repeat(64),
        slot: "b".repeat(32),
        launchId: "l",
        spec,
      } as never;
    });
    const r = row();
    await bed.vmLaunch.spawn(r, launch(), hostInit(r));
    expect(order).toEqual([`image:${PROJECT}`, "recheck", "spawn"]);
  });

  it("starts nothing when the recheck refuses (the project went while its image was built)", async () => {
    const bed = setup({
      recheck: () => {
        throw Object.assign(new Error("gone"), { code: "not_found" });
      },
    });
    const r = row();
    await expect(bed.vmLaunch.spawn(r, launch(), hostInit(r))).rejects.toThrow("gone");
    expect(bed.spawn).not.toHaveBeenCalled();
  });

  it("refuses a row of an agent with a project launch, and an agent launch for a row with no agent", async () => {
    const bed = setup();
    const agentRow = row({ agentId: "atlas-1a2b", agentRole: "thread" });
    expect(await codeOf(bed.vmLaunch.spawn(agentRow, launch(), hostInit(agentRow)))).toBe("internal");
    const asAgent = {
      agent: { id: "atlas-1a2b", name: "A", role: "r" },
      role: "thread",
      vm: true,
    } as AgentLaunch;
    expect(await codeOf(bed.vmLaunch.spawn(row(), asAgent, hostInit(row())))).toBe("internal");
    expect(bed.spawn).not.toHaveBeenCalled();
  });

  it("refuses a launch with no box image resolver, and host rules in the init", async () => {
    const noImage = createVmLaunch({
      runtime: { spawn: vi.fn() } as never,
      papHome: HOME,
      layoutOf: () => layout,
      joinLaunch: () => {},
      imageTagOf: () => IMAGE,
      mirrors: { inputFor: () => ({}) as never },
      logger: silentLogger,
      packageSources: async () => null,
      toImageEntries: () => null,
    });
    const r = row();
    expect(await codeOf(noImage.spawn(r, launch(), hostInit(r)))).toBe("sandbox_unavailable");
    const bed = setup();
    const hostRules = {
      ...hostInit(r),
      policy: PolicyRules.parse({ profile: "interactive", approvalMode: "supervised" }),
    };
    expect(await codeOf(bed.vmLaunch.spawn(r, launch(), hostRules))).toBe("internal");
    expect(bed.spawn).not.toHaveBeenCalled();
  });
});
