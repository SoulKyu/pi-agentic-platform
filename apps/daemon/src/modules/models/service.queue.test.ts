import { type HelperPool } from "../../kernel/helper/pool.ts";
import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { createModelsService } from "./index.ts";
import { signInDeps } from "./testing/bed.ts";
import { WRITE_QUEUE_MAX } from "./service.ts";

/** A pool whose runs end only when the test says so, so the order in which helpers start is visible. */
function gatedPool() {
  const started: string[] = [];
  const gates: Array<{ op: string; finish: (value: unknown) => void; fail: (error: Error) => void }> = [];
  const pool: HelperPool = {
    run: (op) => {
      started.push(op);
      const done = new Promise<unknown>((resolve, reject) => {
        gates.push({ op, finish: resolve, fail: reject });
      });
      done.catch(() => {});
      return { done, answer: () => false, cancel: () => {} };
    },
    active: () => 0,
    stopAll: async () => {},
  };
  return { pool, started, gates };
}
const bed = () => {
  const gated = gatedPool();
  const service = createModelsService({
    helpers: gated.pool,
    projects: { covers: () => true },
    logger: captureLogger().logger,
    ...signInDeps,
  });
  return { ...gated, service };
};
const caller = testCaller();
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const clear = { op: { op: "clear" } } as const;

describe("models service: settings writes are serialised", () => {
  it("starts a write's helper only after the previous write ended, whatever the method", async () => {
    const { service, started, gates } = bed();
    const first = service.setEnabled(caller, clear);
    const second = service.setDefault(caller, { provider: "p", modelId: "m" });
    const third = service.setDefaultThinking(caller, { level: "low" });
    await settle();
    expect(started).toEqual(["models.setEnabled"]);
    gates[0]?.finish({ patterns: null });
    expect(await first).toEqual({ patterns: null });
    await settle();
    expect(started).toEqual(["models.setEnabled", "models.setDefault"]);
    gates[1]?.finish({ ok: true });
    await second;
    await settle();
    gates[2]?.finish({ ok: true });
    await third;
    expect(started).toEqual(["models.setEnabled", "models.setDefault", "models.setDefaultThinking"]);
  });

  it("lets the next write run after one failed, and reports each outcome to its own caller", async () => {
    const { service, started, gates } = bed();
    const first = service.setEnabled(caller, clear);
    const second = service.setEnabled(caller, clear);
    await settle();
    gates[0]?.fail(new PapError("conflict"));
    await expect(first).rejects.toMatchObject({ code: "conflict" });
    await settle();
    expect(started).toHaveLength(2);
    gates[1]?.finish({ patterns: null });
    expect(await second).toEqual({ patterns: null });
  });

  it("does not queue reads behind a write", async () => {
    const { service, started } = bed();
    void service.setEnabled(caller, clear);
    void service.overview(caller).catch(() => undefined);
    await settle();
    expect([...started].sort()).toEqual(["models.overview", "models.setEnabled"]);
  });

  it("refuses with capacity when the queue is full, runs nothing for the refused one, and accepts again after", async () => {
    const { service, started, gates } = bed();
    const accepted = Array.from({ length: WRITE_QUEUE_MAX }, () => service.setEnabled(caller, clear));
    await expect(service.setEnabled(caller, clear)).rejects.toMatchObject({ code: "capacity" });
    for (let i = 0; i < WRITE_QUEUE_MAX; i++) {
      await settle();
      gates[i]?.finish({ patterns: null });
    }
    await Promise.all(accepted);
    expect(started).toHaveLength(WRITE_QUEUE_MAX);
    const again = service.setEnabled(caller, clear);
    await settle();
    gates[WRITE_QUEUE_MAX]?.finish({ patterns: null });
    expect(await again).toEqual({ patterns: null });
  });

  it("checks the cwd before it takes a place in the queue", async () => {
    const gated = gatedPool();
    const service = createModelsService({
      helpers: gated.pool,
      projects: { covers: () => false },
      logger: captureLogger().logger,
      ...signInDeps,
    });
    for (let i = 0; i < WRITE_QUEUE_MAX + 2; i++)
      await expect(service.setEnabled(caller, { ...clear, cwd: "/etc" })).rejects.toMatchObject({
        code: "invalid_cwd",
      });
  });
});

describe("models service: the models.json save shares the settings write queue (MC29)", () => {
  const confirmed = () => testCaller({ stepUpUntil: signInDeps.clock.now() + 60_000 });
  const config = { text: "{}", baseRevision: "a".repeat(64) };

  it("starts no settings write while a save runs, and no save while a settings write runs", async () => {
    const { service, started, gates } = bed();
    const save = service.configSave(confirmed(), config);
    const write = service.setDefault(caller, { provider: "p", modelId: "m" });
    await settle();
    expect(started).toEqual(["models.config.save"]);
    gates[0]?.finish({ revision: "b".repeat(64), enabledModelsSynced: true });
    await save;
    await settle();
    expect(started).toEqual(["models.config.save", "models.setDefault"]);
    gates[1]?.finish({ ok: true });
    await write;

    const second = bed();
    const first = second.service.setEnabled(caller, clear);
    const later = second.service.configSave(confirmed(), config);
    await settle();
    expect(second.started).toEqual(["models.setEnabled"]);
    second.gates[0]?.finish({ patterns: null });
    await first;
    await settle();
    expect(second.started).toEqual(["models.setEnabled", "models.config.save"]);
    second.gates[1]?.finish({ revision: "b".repeat(64), enabledModelsSynced: true });
    await later;
  });
});
