import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createPiWriteQueue, WRITE_QUEUE_MAX } from "../../kernel/pi-write-queue.ts";
import type { HelperPool } from "../../kernel/helper/pool.ts";
import { testCaller } from "../../testing/caller.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createModelsService } from "../models/index.ts";
import { signInDeps } from "../models/testing/bed.ts";
import { createMcpService } from "./service.ts";

/** A pool whose runs end only when the test says so, so the order in which helpers start is visible. */
function gatedPool() {
  const started: string[] = [];
  const gates: Array<(value: unknown) => void> = [];
  const pool: HelperPool = {
    run: (op) => {
      started.push(op);
      const done = new Promise<unknown>((resolve) => gates.push(resolve));
      return { done, answer: () => false, cancel: () => {} };
    },
    active: () => 0,
    stopAll: async () => {},
  };
  return { pool, started, gates };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const caller = testCaller();

function shared() {
  const gated = gatedPool();
  const writes = createPiWriteQueue();
  const { logger } = captureLogger();
  const models = createModelsService({
    helpers: gated.pool,
    projects: { covers: () => true },
    logger,
    ...signInDeps,
    writes,
  });
  const mcp = createMcpService({
    helpers: gated.pool,
    projects: { covers: () => true },
    logger,
    clock: signInDeps.clock,
    writes,
  });
  return { ...gated, models, mcp, writes };
}

describe("Pi's write queue is shared by the models and the MCP writes (MC29)", () => {
  it("starts a code mode write only after a models write ended, and the reverse", async () => {
    const bed = shared();
    const models = bed.models.setDefaultThinking(caller, { level: "low" });
    const codemode = bed.mcp.setCodemode(caller, { choice: "always" });
    await settle();
    expect(bed.started).toEqual(["models.setDefaultThinking"]);
    bed.gates[0]?.({ ok: true });
    await models;
    await settle();
    expect(bed.started).toEqual(["models.setDefaultThinking", "mcp.codemode"]);
    bed.gates[1]?.({ choice: "always", mode: "on", inlineBudget: null });
    await codemode;

    const reverse = shared();
    const first = reverse.mcp.setCodemode(caller, { mode: "only" });
    const second = reverse.models.setDefaultThinking(caller, { level: "low" });
    await settle();
    expect(reverse.started).toEqual(["mcp.codemode"]);
    reverse.gates[0]?.({ choice: "automatic", mode: "only", inlineBudget: null });
    await first;
    await settle();
    expect(reverse.started).toEqual(["mcp.codemode", "models.setDefaultThinking"]);
    reverse.gates[1]?.({ ok: true });
    await second;
  });

  it("counts both services in one capacity: a full queue refuses with capacity whoever asks, and drops nothing", async () => {
    const bed = shared();
    const accepted = Array.from({ length: WRITE_QUEUE_MAX }, (_, i) =>
      i % 2 === 0
        ? bed.mcp.setCodemode(caller, { mode: "only" })
        : bed.models.setDefaultThinking(caller, { level: "low" }),
    );
    await expect(bed.mcp.setCodemode(caller, { mode: "on" })).rejects.toEqual(new PapError("capacity"));
    await expect(bed.models.setDefaultThinking(caller, { level: "low" })).rejects.toEqual(
      new PapError("capacity"),
    );
    for (let i = 0; i < WRITE_QUEUE_MAX; i++) {
      await settle();
      bed.gates[i]?.(i % 2 === 0 ? { choice: "automatic", mode: "only", inlineBudget: null } : { ok: true });
    }
    await Promise.all(accepted);
    expect(bed.started).toHaveLength(WRITE_QUEUE_MAX);
  });

  it("serialises mcp file writes with each other too", async () => {
    const bed = shared();
    const first = bed.mcp.remove(caller, { scope: "global", name: "a" });
    const second = bed.mcp.add(testCaller({ stepUpUntil: signInDeps.clock.now() + 1000 }), {
      scope: "global",
      name: "b",
      entry: { command: "x" },
    });
    await settle();
    expect(bed.started).toEqual(["mcp.remove"]);
    bed.gates[0]?.({ index: 0, entry: "{}" });
    await first;
    await settle();
    expect(bed.started).toEqual(["mcp.remove", "mcp.add"]);
    bed.gates[1]?.({ ok: true });
    await second;
  });
});
