import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { newHookSecret } from "./hook-auth.ts";
import { mountHookRoute } from "./hooks-http.ts";
import { refuseStoredPrecheck } from "./precheck-refusal.ts";
import { createRetry } from "./retry.ts";
import { writeTriggerSecret } from "./trigger-secrets.ts";
import { parsedInput } from "./testing/bed.ts";
import { createRunnerBed, type RunnerBed } from "./testing/runner-bed.ts";

let bed: RunnerBed;
let dir: string | null = null;
afterEach(() => {
  bed.dispose();
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

const journal = () =>
  bed.db.all<{ verdict: string; detail: string | null; source: string; count: number }>(
    "SELECT verdict, detail, source, count FROM trigger_fires ORDER BY id",
  );
const taskCount = () => bed.db.all("SELECT 1 FROM tasks").length;

function webhookWithPrecheck() {
  bed = createRunnerBed();
  return bed.triggers.create(
    bed.owner(),
    parsedInput({
      name: "Alert hook",
      enabled: true,
      source: { type: "webhook", auth: "secret" },
      execution: { cwd: bed.folder, precheck: "check.sh" },
      prompt: "Alert: {{payload}}",
    }),
  ).trigger;
}

describe("a stored precheck is refused at every fire (B6)", () => {
  it("a webhook fire answers 409 precheck_removed, journals it and spawns nothing", async () => {
    const trigger = webhookWithPrecheck();
    dir = mkdtempSync(join(tmpdir(), "pap-hooks-precheck-"));
    const secret = newHookSecret();
    writeTriggerSecret(dir, trigger.id, secret);
    const app = new Hono();
    mountHookRoute(app, {
      clock: bed.clock,
      logger: captureLogger().logger,
      readOnly: false,
      secretsDir: dir,
      find: (id) => bed.triggers.get("u1", id),
      fire: bed.engine.fire,
      refusePrecheck: (record) => refuseStoredPrecheck({ db: bed.db, clock: bed.clock }, record, "webhook"),
    });
    const response = await app.request(`/hooks/${trigger.id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ reason: "precheck_removed" });
    expect(journal()).toEqual([
      { verdict: "error", detail: "precheck_removed", source: "webhook", count: 1 },
    ]);
    expect(taskCount()).toBe(0);
  });

  it("a retry of a task whose trigger holds one is refused and starts no task", () => {
    const trigger = webhookWithPrecheck();
    const TASK = "0b1c2d3e-0001-4000-8000-000000000002";
    bed.engine.store.insert({
      id: TASK,
      ownerId: "u1",
      triggerId: trigger.id,
      origin: "webhook",
      cwd: bed.folder,
      prompt: "p",
      tainted: false,
      gated: true,
      policy: { mode: "supervised", tools: ["read"], preset: "read-only", env: [] },
      title: "t",
      detail: null,
      retryOf: null,
      retryOnInterrupt: false,
      maxRunMs: 600_000,
      maxRunUsd: null,
      at: bed.clock.now(),
    });
    bed.db.run("UPDATE tasks SET state = 'failed', ended_at = $at WHERE id = $id", {
      id: TASK,
      at: bed.clock.now(),
    });
    const retry = createRetry({
      store: bed.engine.store,
      triggers: bed.triggers,
      fire: bed.engine.fire,
      refusePrecheck: (record) => refuseStoredPrecheck({ db: bed.db, clock: bed.clock }, record, "retry"),
    });
    expect(() => retry("u1", TASK, { gated: true })).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(taskCount()).toBe(1);
    expect(journal()).toEqual([{ verdict: "error", detail: "precheck_removed", source: "retry", count: 1 }]);
  });
});
