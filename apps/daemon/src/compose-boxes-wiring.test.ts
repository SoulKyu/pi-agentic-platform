import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_PROJECT_RESOURCES } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { type BoxWiringDeps, composeBoxWiring, projectNoticeOf } from "./compose-boxes-wiring.ts";
import { composeBoxes } from "./compose-boxes.ts";
import { createFakeClock } from "./kernel/clock.ts";
import { silentLogger } from "./kernel/logger.ts";
import { createLaunchRegistry } from "./modules/agent-vm/index.ts";
import { createFakeProjectBoxSource } from "./kernel/testing/fake-boxes.ts";
import type { SessionRow } from "./modules/sessions/index.ts";
import { captureLogger } from "./testing/capture-logger.ts";

const HOME = "/pap";
const ID = "6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d11";
const ROOT = `${HOME}/tmp/boxes/${ID}/project`;
const row = (cwd: string): SessionRow => ({ id: "s1", ownerId: "u1", cwd, piPath: null }) as SessionRow;

function build(logger = silentLogger) {
  const boxes = composeBoxes(HOME, logger, null);
  const boxSource = createFakeProjectBoxSource({
    [ID]: { ownerId: "u1", root: ROOT, resources: DEFAULT_PROJECT_RESOURCES, hosts: [], deleting: false },
  });
  const bindBoxes = vi.fn();
  const runtime = {
    onPhase: () => () => {},
    phase: () => "stopped",
    stop: async () => {},
    start: async () => {},
    resume: () => {},
    close: () => {},
    reopen: () => {},
    link: () => undefined,
  };
  const clock = createFakeClock();
  const deps = {
    vm: {
      runtime,
      launches: createLaunchRegistry({ clock, logger }),
      boxes,
      boxStack: { backend: "process", client: null, gate: async () => {} },
      resourceHost: () => ({ memoryCapMb: 8192, cores: 4 }),
    },
    projects: { boxSource, port: { list: () => [{ name: "Api" }] }, bindBoxes },
    clock,
    logger,
    home: HOME,
    requireStepUp: () => {},
  } as unknown as BoxWiringDeps;
  return { boxes, bindBoxes, wiring: composeBoxWiring(deps) };
}

describe("the order of the boxes in the daemon (boot, fail closed)", () => {
  const source = readFileSync(fileURLToPath(new URL("./daemon.ts", import.meta.url)), "utf8");
  const at = (needle: string): number => {
    const found = source.indexOf(needle);
    expect(found, needle).toBeGreaterThan(0);
    return found;
  };

  it("builds the boxes right after the projects module and before every module that reads a path", () => {
    const wired = at("composeBoxWiring(");
    expect(wired).toBeGreaterThan(at("createProjectsModule("));
    for (const later of ["createWorkspaceModules(", "composeLanes(", "createSessionsModule(", "composeM10("])
      expect(wired, later).toBeLessThan(at(later));
    expect(at("boxes.bind(")).toBeLessThan(at("agentsVm.bindLate("));
    expect(at("agentsVm.bindLate(")).toBeLessThan(at("startServer("));
  });

  it("hands the box source to the sessions, the lanes and the workspace", () => {
    expect(source).toContain("...boxes.workspace");
    expect(source.match(/boxes: boxes\.workspace\.boxes/g)).toHaveLength(2);
  });
});

describe("the box source is bound when the wiring is built", () => {
  it("makes a cwd under a box root a box row before the late binding, so it is never a host path", () => {
    const { boxes, wiring } = build();
    expect(boxes.sessions.projectOf(row(ROOT))).toBe(ID);
    expect(boxes.sessions.projectOf(row(`${ROOT}/src`))).toBe(ID);
    expect(boxes.sessions.projectOf(row("/home/u/work"))).toBeNull();
    expect(wiring.workspace.boxes().byPath("u1", ROOT)).toMatchObject({ projectId: ID });
  });
});

describe("what the projects module is bound with", () => {
  it("removes the pause item of a deleted project, matching its project id", async () => {
    const { wiring, bindBoxes } = build();
    const removeRef = vi.fn();
    const removeProject = vi.fn(async () => ({ sessions: 2 }));
    wiring.bind({
      sessions: {
        projectCleanup: { count: () => 2, removeProject, liveIds: () => [] },
        mirror: { notice() {}, taint() {} },
      },
      automation: { projectPort: { count: () => 0, removeProject: async () => ({ triggers: 0 }) } },
      inbox: { agentItems: { removeRef } },
    } as never);
    const bound = bindBoxes.mock.calls[0]?.[0] as {
      sessions: { removeProject(o: string, p: string): Promise<unknown> };
    };
    expect(await bound.sessions.removeProject("u1", ID)).toEqual({ sessions: 2 });
    expect(removeRef).toHaveBeenCalledWith("u1", "box_paused", ID);
  });

  it("posts an image notice to the project's live sessions, in the words of a box", () => {
    const { wiring } = build();
    const notice = vi.fn();
    const late = wiring.bind({
      sessions: {
        projectCleanup: {
          count: () => 0,
          removeProject: async () => ({ sessions: 0 }),
          liveIds: () => ["s1", "s2"],
        },
        mirror: { notice, taint() {} },
      },
      automation: { projectPort: { count: () => 0, removeProject: async () => ({ triggers: 0 }) } },
      inbox: { agentItems: { removeRef() {} } },
    } as never);
    late.notice?.(ID, "Une nouvelle image est en préparation ; cet agent tourne sur l'ancienne.");
    expect(notice.mock.calls).toEqual([
      ["s1", "Une nouvelle image est en préparation ; cette box tourne sur l'ancienne."],
      ["s2", "Une nouvelle image est en préparation ; cette box tourne sur l'ancienne."],
    ]);
  });

  it("logs a notice for a project that has nothing to tell it to", () => {
    const captured = captureLogger();
    const { wiring } = build(captured.logger);
    wiring
      .bind({
        sessions: { projectCleanup: { liveIds: () => [] }, mirror: { notice() {}, taint() {} } },
        automation: { projectPort: {} },
        inbox: { agentItems: {} },
      } as never)
      .notice?.("0a1b2c3d-1111-4222-8333-444455556666", "x");
    expect(captured.lines.map((line) => line.msg)).toContain("box_notice_no_session");
  });

  it("keeps the words of a notice it does not know", () => {
    expect(projectNoticeOf("autre texte")).toBe("autre texte");
    expect(
      projectNoticeOf(
        "Cet agent doit être reconstruit pour cette version de pap ; il redémarrera quand l'image sera prête.",
      ),
    ).toMatch(/^Cette box/);
  });
});
