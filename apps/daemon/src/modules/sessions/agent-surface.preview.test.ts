import type { PlatformOp } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createAgentSurface } from "./agent-surface.ts";
import type { SessionRow } from "./store.ts";

const P1 = "6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d11";

const row = (id: string, cwd: string, extra: Partial<SessionRow> = {}): SessionRow => ({
  id,
  piPath: null,
  piSessionId: null,
  cwd,
  ownerId: "u1",
  name: null,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});
const rows: Record<string, SessionRow> = {
  boxed: row("boxed", `/boxes/${P1}/project`),
  host: row("host", "/home/u/code"),
  thread: row("thread", "/home/u/agent", { agentId: "atlas-0001", agentRole: "thread" }),
  child: row("child", "/home/u/code", { parentSessionId: "host" }),
  task: row("task", "/home/u/agent", { agentId: "atlas-0001", agentRole: "task" }),
  lane: row("lane", "/home/u/lanes/a"),
};

function surface() {
  const { logger } = captureLogger();
  const made = createAgentSurface({
    store: { get: (id: string) => rows[id], readOnly: false } as never,
    policy: { sessionPolicy: () => ({ taint: { tainted: false }, toolAllowlist: null }) } as never,
    clock: {} as never,
    logger,
    worker: { papHome: "/pap", agentDir: "/pi" },
    inLane: (_owner: string, cwd: string) => cwd.startsWith("/home/u/lanes/"),
  } as never);
  made.setAgentPorts({
    platform: { available: () => true } as never,
    agents: {
      profileOf: () => null,
      boxes: {
        projectOf: (r: SessionRow) => (r.cwd === `/boxes/${P1}/project` ? P1 : null),
        box: () => ({ hosts: [] }),
      },
    },
  } as never);
  return made;
}

describe("the preview ops on the agent surface (UX2-R26)", () => {
  it("an agent thread and a box's plain session get preview_start and preview_stop; a host plain session, a task, a lane and a child get neither", () => {
    const s = surface();
    const ops = (id: string): PlatformOp[] =>
      s.platformOps(rows[id] as SessionRow).filter((op) => op.startsWith("preview."));
    const both: PlatformOp[] = ["preview.start", "preview.stop"];
    expect(ops("thread")).toEqual(both);
    expect(ops("boxed")).toEqual(both);
    expect(ops("host")).toEqual([]);
    expect(ops("task")).toEqual([]);
    expect(ops("lane")).toEqual([]);
    expect(ops("child")).toEqual([]);
  });
});
