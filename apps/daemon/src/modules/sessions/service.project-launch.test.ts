import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PROJECT_RESOURCES, PolicyRules } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectBoxRow, ProjectBoxSource } from "../../kernel/boxes.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createFakeProjectBoxSource } from "../../kernel/testing/fake-boxes.ts";
import { projectLayoutOf, type VmSpec } from "../agent-vm/index.ts";
import type { SessionBoxes } from "./project-gate.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore, type SessionRow } from "./store.ts";
import { fakePolicyPort, initRecordOf } from "./testing/fake-policy.ts";
import { fakeProjectsPort } from "./testing/fake-projects.ts";
import { codeOf } from "./testing/helpers.ts";
import { createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";
import { createVmLaunch } from "./vm-launch.ts";

const PROJECT = "6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d11";
const IMAGE = `pap-agent-agent-${"c".repeat(64)}`;

/** The host calls a box row must never make before its worker starts: the policy scope (realpath, `.git` walk) and the knowledge probe. */
const probes = { scopeOf: vi.fn((cwd: string) => cwd), knowledgeRootOf: vi.fn((): string | null => null) };
let atInit: { scope: number; knowledge: number } | null;
let bed: ReturnType<typeof setup>["bed"];
let boxes: ReturnType<typeof boxesOf>;

/** The sessions' view of the project boxes, as the composition gives it (`compose-boxes.ts` has its own tests): by the source's `byPath`. */
function boxesOf(papHome: string, source: ProjectBoxSource) {
  const sessions: SessionBoxes = {
    projectOf: (row) =>
      row.agentId === undefined ? (source.byPath(row.ownerId, row.cwd)?.projectId ?? null) : null,
    box: (projectId) => source.box(projectId),
    claudeTokenSet: () => false,
    addHost: () => undefined,
  };
  return {
    sessions,
    vmLayoutOf: (row: SessionRow) => {
      const projectId = sessions.projectOf(row);
      return projectId === null ? null : projectLayoutOf("process", papHome, projectId);
    },
  };
}
afterEach(() => bed.dispose());

function setup(row: Partial<ProjectBoxRow> = {}) {
  probes.scopeOf.mockClear();
  probes.knowledgeRootOf.mockClear();
  atInit = null;
  const specs: VmSpec[] = [];
  const policy = { ...fakePolicyPort(), scopeOf: probes.scopeOf };
  const projects = { ...fakeProjectsPort(), knowledgeRootOf: probes.knowledgeRootOf };
  // The source needs the bed's `$PAP_HOME` for its roots, and the bed needs the source: it is filled in below.
  let current: ProjectBoxSource | null = null;
  const source: ProjectBoxSource = {
    box: (id) => current?.box(id) ?? null,
    ownerBoxes: (ownerId) => current?.ownerBoxes(ownerId) ?? [],
    byPath: (ownerId, path) => current?.byPath(ownerId, path) ?? null,
    addHost: () => {},
  };
  const made = createServiceBed(
    { createSessionsStore, createSessionsService, loadTranscriptReader },
    {
      policy,
      projects,
      start: (_index, init) => {
        atInit = {
          scope: probes.scopeOf.mock.calls.length,
          knowledge: probes.knowledgeRootOf.mock.calls.length,
        };
        void init;
        return undefined;
      },
      vmLaunch: (makeWorker, { papHome }) => {
        boxes = boxesOf(papHome, source);
        return createVmLaunch({
          runtime: {
            async spawn(spec: VmSpec) {
              specs.push(spec);
              return {
                handle: Object.assign(makeWorker(), { slot: "b".repeat(32), piFile: () => null }),
                layout: projectLayoutOf("process", papHome, PROJECT),
                relayKey: "a".repeat(64),
                slot: "b".repeat(32),
                launchId: "launch-1",
              };
            },
          } as never,
          papHome,
          packageSources: async () => null,
          joinLaunch: () => {},
          toImageEntries: () => null,
          layoutOf: (r) => boxes.vmLayoutOf(r as never),
          imageTagOf: () => IMAGE,
          projectImageTagOf: () => IMAGE,
          mirrors: {
            inputFor: () => ({
              sessionFile: null,
              sessionsDir: "/ignored",
              mirrorFor: () => "refused",
              unsent: () => false,
              sent: () => {},
            }),
          },
          logger: silentLogger,
        });
      },
    },
  );
  bed = made;
  const papHome = join(made.dir, "pap");
  const root = join(papHome, "tmp", "boxes", PROJECT);
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const found: ProjectBoxRow = {
    ownerId: "u1",
    root,
    resources: DEFAULT_PROJECT_RESOURCES,
    hosts: ["project.example.test"],
    deleting: false,
    ...row,
  };
  current = createFakeProjectBoxSource({ [PROJECT]: found });
  made.service.agent.setAgentPorts({
    agents: {
      profileOf: () => null,
      vmLayoutOf: boxes.vmLayoutOf,
      boxes: boxes.sessions,
    },
  });
  return { bed: made, specs, project, papHome };
}

describe("a session in a project's box (task A3)", () => {
  it("launches a project row in its project box, never on the host", async () => {
    const { specs, project, papHome } = setup();
    const { sessionId } = await bed.service.create(project, OWNER);
    expect(specs).toEqual([
      expect.objectContaining({ box: { kind: "project", id: PROJECT }, kind: "thread", taskKey: null }),
    ]);
    const init = initRecordOf(bed.spawned[0]);
    const layout = projectLayoutOf("process", papHome, PROJECT);
    expect(init).toMatchObject({ cwd: layout.project, papSessionId: sessionId, agentDir: layout.piAgentDir });
    expect(init.vm).toMatchObject({ layout, bwrap: "/usr/bin/bwrap" });
    expect(init.knowledge).toEqual({ path: `${layout.project}/knowledge` });
    expect(init).not.toHaveProperty("agent");
    expect(init).not.toHaveProperty("testProviderScript");
    expect(JSON.stringify(init)).not.toContain(join(papHome, "agents"));
  });

  it("composes the project profile: own folder at the project, a sandboxed shell with the network, the owner's and the project's hosts", async () => {
    const { project, papHome } = setup();
    await bed.service.create(project, OWNER);
    const layout = projectLayoutOf("process", papHome, PROJECT);
    const rules = PolicyRules.parse(initRecordOf(bed.spawned[0]).policy);
    expect(rules).toMatchObject({
      profile: "project",
      agentHome: layout.project,
      agentScratch: null,
      sandbox: { required: true, network: true },
      allowHosts: ["project.example.test"],
      alwaysAllow: [],
      alwaysPrefixes: [],
      alwaysTools: [],
    });
  });

  it("asks the host nothing about the box path before its worker starts (no scope, no knowledge probe)", async () => {
    const { project } = setup();
    await bed.service.create(project, OWNER);
    expect(atInit).toEqual({ scope: 0, knowledge: 0 });
  });

  it("a task row of a project box uses the same box and keeps the task's mode", async () => {
    const { specs, project } = setup();
    await bed.service.create(project, OWNER);
    await bed.service.automation.createTaskSession({
      ownerId: "u1",
      cwd: project,
      policy: { mode: "supervised", tools: ["bash"], preset: "full", tainted: false },
    });
    expect(specs.map((spec) => [spec.box, spec.kind, spec.taskKey])).toEqual([
      [{ kind: "project", id: PROJECT }, "thread", null],
      [{ kind: "project", id: PROJECT }, "thread", null],
    ]);
    const task = PolicyRules.parse(initRecordOf(bed.spawned[1]).policy);
    expect(task).toMatchObject({ profile: "project", approvalMode: "supervised" });
  });

  it("refuses fork and clone of a box session with sandbox_unavailable, before any host Pi call", async () => {
    const { project } = setup();
    const { sessionId } = await bed.service.create(project, OWNER);
    expect(await codeOf(bed.service.fork({ sessionId, entryId: "e1" }, OWNER))).toBe("sandbox_unavailable");
    expect(await codeOf(bed.service.clone({ sessionId }, OWNER))).toBe("sandbox_unavailable");
  });

  it("refuses a deleting project and a box that is gone with not_found, starting nothing", async () => {
    const { specs, project } = setup({ deleting: true });
    expect(await codeOf(bed.service.create(project, OWNER))).toBe("not_found");
    expect(specs).toEqual([]);
    expect(bed.spawned).toHaveLength(0);
  });

  it("takes another owner's box for no box of this owner's rows (the source matches by owner)", async () => {
    const { specs, project } = setup({ ownerId: "u2" });
    // The source matches paths of its own owner only: u1's row is no box row, and so a host row (the host path rules decide).
    expect(await codeOf(bed.service.create(project, OWNER))).toBeNull();
    expect(specs).toEqual([]);
  });

  it("refuses HTML export of a box row: the VM would write a host path", async () => {
    const { project } = setup();
    const { sessionId } = await bed.service.create(project, OWNER);
    expect(await codeOf(bed.service.exportHtml(sessionId, OWNER))).toBe("sandbox_unavailable");
  });

  it("cuts a box path out of the lane index: a lane worktree check never runs on it", async () => {
    const { project } = setup();
    const inLane = vi.fn(() => false);
    bed.service.agent.setAgentPorts({ inLane });
    await bed.service.create(project, OWNER);
    expect(inLane).not.toHaveBeenCalled();
  });
});
