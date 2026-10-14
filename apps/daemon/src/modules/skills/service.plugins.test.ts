import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { HelperPool } from "../../kernel/helper/pool.ts";
import { createPiWriteQueue } from "../../kernel/pi-write-queue.ts";
import { testCaller } from "../../testing/caller.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { fakePool, type RunCall } from "../models/testing/bed.ts";
import { createSkillsService } from "./service.ts";

const PLUGIN = {
  source: "../../pkgs/tools",
  scope: "user",
  installedPath: "/h/pkgs/tools",
  enabled: true,
  filtered: false,
};
const answerFor = (call: RunCall): unknown => {
  switch (call.op) {
    case "plugins.list":
      return { plugins: [PLUGIN], truncated: false };
    case "plugins.update":
      return { updated: [{ source: "npm:x", scope: "user" }] };
    case "plugins.setEnabled":
      return { results: [{ source: "npm:x", scope: "user", ok: true }] };
    default:
      return { ok: true };
  }
};
const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : "other"),
  );
function bed(answer: (call: RunCall) => unknown = answerFor) {
  const { pool, calls } = fakePool(answer);
  const clock = createFakeClock();
  const service = createSkillsService({
    helpers: pool,
    projects: { covers: (owner, cwd) => owner === "u1" && cwd.startsWith("/w/api") },
    logger: captureLogger().logger,
    clock,
  });
  return { service, calls, clock };
}
const caller = testCaller();
const project = "/w/api";
const stepped = (clock: { now(): number }) => testCaller({ stepUpUntil: clock.now() + 60_000 });
const src = { source: "npm:@example/pi-tools@1.0.0" };

describe("plugins.list", () => {
  it("runs the read in a helper with the caller's folder as the run's and parses the answer", async () => {
    const { service, calls } = bed();
    expect(await service.listPlugins(caller, project)).toEqual({ plugins: [PLUGIN], truncated: false });
    expect(calls[0]).toMatchObject({ op: "plugins.list", params: {}, options: { cwd: project } });
    expect(await codeOf(service.listPlugins(caller, "/etc"))).toBe("invalid_cwd");
    expect(calls).toHaveLength(1);
  });

  it("fails closed on a field the contract does not list", async () => {
    const { service } = bed(() => ({ plugins: [{ ...PLUGIN, env: { TOKEN: "x" } }], truncated: false }));
    expect(await codeOf(service.listPlugins(caller))).toBe("helper_failed");
  });
});

describe("user scope: install and update take a live step-up (M7R140)", () => {
  it("install without a step-up is step_up_required and starts no helper", async () => {
    const { service, calls } = bed();
    expect(await codeOf(service.installPlugin(caller, { ...src, scope: "user" }))).toBe("step_up_required");
    expect(calls).toHaveLength(0);
  });

  it("install with one runs without a folder, ignores a cwd, and has room for five minutes", async () => {
    const { service, calls, clock } = bed();
    await service.installPlugin(stepped(clock), { ...src, scope: "user", cwd: "/etc" });
    expect(calls[0]).toMatchObject({ op: "plugins.install", params: { ...src, scope: "user" } });
    expect(calls[0]?.params).not.toHaveProperty("cwd");
    expect(calls[0]?.options.cwd).toBeUndefined();
    expect(calls[0]?.options.deadlineMs).toBeGreaterThan(300_000);
  });

  it("update without a scope is the user scope, and takes the step-up", async () => {
    const { service, calls, clock } = bed();
    expect(await codeOf(service.updatePlugins(caller, {}))).toBe("step_up_required");
    expect(await service.updatePlugins(stepped(clock), {})).toEqual({
      updated: [{ source: "npm:x", scope: "user" }],
    });
    expect(calls).toHaveLength(1);
  });

  it("remove and switch need no step-up", async () => {
    const { service, calls } = bed();
    await service.removePlugin(caller, { ...src, scope: "user" });
    await service.setPluginsEnabled(caller, { items: [{ ...src, scope: "user" }], enabled: false });
    expect(calls.map((call) => call.op)).toEqual(["plugins.remove", "plugins.setEnabled"]);
  });
});

describe("project scope: a folder of the caller's, the confirmation and no step-up", () => {
  it("is bad_request without a folder, invalid_cwd for a stranger's, protected_path without the confirmation", async () => {
    const { service, calls } = bed();
    const confirmed = { confirmProtected: true as const };
    const call = (fn: "installPlugin" | "removePlugin", extra: object) =>
      codeOf(service[fn](caller, { ...src, scope: "project", ...extra }));
    for (const fn of ["installPlugin", "removePlugin"] as const) {
      expect(await call(fn, confirmed)).toBe("bad_request");
      expect(await call(fn, { cwd: "/etc", ...confirmed })).toBe("invalid_cwd");
      expect(await call(fn, { cwd: project })).toBe("protected_path");
    }
    expect(await codeOf(service.updatePlugins(caller, { scope: "project", cwd: project }))).toBe(
      "protected_path",
    );
    expect(
      await codeOf(
        service.setPluginsEnabled(caller, {
          items: [{ ...src, scope: "project" }],
          enabled: true,
          cwd: project,
        }),
      ),
    ).toBe("protected_path");
    expect(calls).toHaveLength(0);
  });

  it("a confirmed call runs in the project without a step-up, for all four writes", async () => {
    const { service, calls } = bed();
    const base = { cwd: project, confirmProtected: true as const };
    await service.installPlugin(caller, { ...src, scope: "project", ...base });
    await service.removePlugin(caller, { ...src, scope: "project", ...base });
    await service.updatePlugins(caller, { scope: "project", ...base });
    await service.setPluginsEnabled(caller, {
      items: [
        { ...src, scope: "user" },
        { ...src, scope: "project" },
      ],
      enabled: false,
      ...base,
    });
    expect(calls.map((call) => [call.op, call.options.cwd])).toEqual([
      ["plugins.install", project],
      ["plugins.remove", project],
      ["plugins.update", project],
      ["plugins.setEnabled", project],
    ]);
    for (const call of calls) expect(call.params).not.toHaveProperty("cwd");
  });

  it("passes the helper's refusal of an untrusted project on as forbidden", async () => {
    const { service } = bed(() => new PapError("forbidden"));
    expect(
      await codeOf(
        service.installPlugin(caller, { ...src, scope: "project", cwd: project, confirmProtected: true }),
      ),
    ).toBe("forbidden");
  });
});

describe("the shared Pi write queue (MC29)", () => {
  it("runs a plugin write behind the models' and MCP writes, one at a time", async () => {
    const started: string[] = [];
    const gates: Array<(value: unknown) => void> = [];
    const pool: HelperPool = {
      run: (op) => {
        started.push(op);
        return {
          done: new Promise<unknown>((resolve) => gates.push(resolve)),
          answer: () => false,
          cancel: () => {},
        };
      },
      active: () => 0,
      stopAll: async () => {},
    };
    const writes = createPiWriteQueue();
    const clock = createFakeClock();
    const service = createSkillsService({
      helpers: pool,
      projects: { covers: () => true },
      logger: captureLogger().logger,
      clock,
      writes,
    });
    // Another module's write holds the queue.
    let release: (() => void) | undefined;
    const other = writes.run(() => new Promise<void>((resolve) => (release = resolve)));
    const mine = service.setPluginsEnabled(caller, { items: [{ ...src, scope: "user" }], enabled: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toEqual([]);
    release?.();
    await other;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toEqual(["plugins.setEnabled"]);
    gates[0]?.({ results: [{ ...src, scope: "user", ok: true }] });
    await mine;
  });

  it("refuses with capacity when the queue is full", async () => {
    const pool: HelperPool = {
      run: () => ({ done: new Promise<unknown>(() => {}), answer: () => false, cancel: () => {} }),
      active: () => 0,
      stopAll: async () => {},
    };
    const service = createSkillsService({
      helpers: pool,
      projects: { covers: () => true },
      logger: captureLogger().logger,
      clock: createFakeClock(),
      writes: createPiWriteQueue(1),
    });
    void service.removePlugin(caller, { ...src, scope: "user" });
    expect(await codeOf(service.removePlugin(caller, { ...src, scope: "user" }))).toBe("capacity");
  });
});
