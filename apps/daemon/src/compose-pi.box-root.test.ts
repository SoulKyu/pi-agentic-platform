import { type HandlerContext, PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { withLaneRoots } from "./lane-covers.ts";
import { createFakeClock } from "./kernel/clock.ts";
import { fakePool } from "./modules/models/testing/bed.ts";
import { createPiWriteQueue } from "./kernel/pi-write-queue.ts";
import { createMcpModule } from "./modules/mcp/index.ts";
import type { ProjectsPort } from "./modules/projects/index.ts";
import { createSkillsModule } from "./modules/skills/index.ts";
import { createTrustModule } from "./modules/trust/index.ts";
import { testCaller } from "./testing/caller.ts";
import { captureLogger } from "./testing/capture-logger.ts";

const BOX_ROOT = "/pap/boxes/6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d11/project";
/** The projects as `composePi` hands them to the Pi modules: the port, with the lane roots, `coversHost` underneath. */
const port = withLaneRoots(
  {
    covers: (_owner: string, path: string) => path.startsWith(BOX_ROOT) || path.startsWith("/w/api"),
    coversHost: (_owner: string, path: string) => path.startsWith("/w/api"),
    roots: () => ["/w/api"],
  } as unknown as ProjectsPort,
  () => [],
);
const ctxOf = (caller = testCaller()): HandlerContext => ({
  caller,
  connectionId: "c1",
  openSubscription: () => "s1",
  closeSubscription: () => {},
});
const ctx = ctxOf();
const stepped = ctxOf(testCaller({ stepUpUntil: Number.MAX_SAFE_INTEGER }));
const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : "other"),
  );

describe("a box project's root never reaches a Pi helper (boxes B1)", () => {
  it("mcp, skills and trust answer invalid_cwd for it and start no helper", async () => {
    const { pool, calls } = fakePool(() => ({}));
    const { logger } = captureLogger();
    const deps = { helpers: pool, projects: port, logger, clock: createFakeClock() };
    const mcp = createMcpModule({ ...deps, writes: createPiWriteQueue() }).rpc;
    const skills = createSkillsModule({ ...deps, writes: createPiWriteQueue() }).rpc;
    const trust = createTrustModule({
      ...deps,
      sessions: { restartFolder: () => 0 },
      audit: { append: () => {} },
    }).rpc;
    for (const path of [BOX_ROOT, `${BOX_ROOT}/src`]) {
      expect(await codeOf(mcp["mcp.overview"]({ cwd: path }, ctx))).toBe("invalid_cwd");
      expect(
        await codeOf(
          mcp["mcp.setEnabled"](
            { servers: [{ scope: "project", name: "x" }], enabled: true, cwd: path, confirmProtected: true },
            ctx,
          ),
        ),
      ).toBe("invalid_cwd");
      expect(await codeOf(skills["skills.list"]({ cwd: path }, ctx))).toBe("invalid_cwd");
      expect(await codeOf(skills["plugins.list"]({ cwd: path }, ctx))).toBe("invalid_cwd");
      expect(await codeOf(trust["trust.status"]({ cwd: path }, ctx))).toBe("invalid_cwd");
      expect(await codeOf(trust["trust.set"]({ cwd: path, decision: true }, stepped))).toBe("invalid_cwd");
    }
    expect(calls).toEqual([]);
  });
});
