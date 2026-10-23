import type { HandlerContext } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { projectsRpc } from "./rpc.ts";
import type { ProjectsService } from "./service.ts";

const caller = testCaller();
const ctx: HandlerContext = {
  caller,
  connectionId: "c1",
  openSubscription: vi.fn(() => "s1"),
  closeSubscription: vi.fn(),
};

describe("projects rpc", () => {
  it("calls the service with the caller and answers ok", async () => {
    const update = vi.fn();
    const rpc = projectsRpc({ update } as unknown as ProjectsService);
    const change = { kind: "move", before: null } as const;
    expect(await rpc["projects.update"]({ projectId: "p1", change }, ctx)).toEqual({ ok: true });
    expect(update).toHaveBeenCalledExactlyOnceWith(caller, "p1", change);
  });

  it("answers projects.add with the service's project for the caller", async () => {
    const view = { id: "p1", root: "/w/api", name: "api", position: -1 };
    const add = vi.fn(() => view);
    const rpc = projectsRpc({ add } as unknown as ProjectsService);
    expect(await rpc["projects.add"]({ root: "/w/api/src" }, ctx)).toEqual({ project: view });
    expect(add).toHaveBeenCalledExactlyOnceWith(caller, "/w/api/src");
  });

  it("answers the knowledge methods from the service, with the caller", async () => {
    const knowledge = vi.fn(() => ({ enabled: false, concepts: 0 }));
    const enableKnowledge = vi.fn(() => ({ enabled: true as const }));
    const rpc = projectsRpc({ knowledge, enableKnowledge } as unknown as ProjectsService);
    expect(await rpc["projects.knowledge"]({ projectId: "p1", sessionId: "s1" }, ctx)).toEqual({
      enabled: false,
      concepts: 0,
    });
    expect(knowledge).toHaveBeenCalledExactlyOnceWith(caller, "p1", "s1");
    expect(await rpc["projects.enableKnowledge"]({ projectId: "p1" }, ctx)).toEqual({ enabled: true });
    expect(enableKnowledge).toHaveBeenCalledExactlyOnceWith(caller, "p1", undefined);
  });
});
