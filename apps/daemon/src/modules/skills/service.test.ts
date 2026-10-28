import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { HelperPool } from "../../kernel/helper/pool.ts";
import { testCaller } from "../../testing/caller.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { fakePool, type RunCall } from "../models/testing/bed.ts";
import { createSkillsService } from "./service.ts";

const SKILL = {
  name: "alpha",
  description: "d",
  path: "/h/.agents/skills/alpha/SKILL.md",
  scope: "user",
  disableModelInvocation: false,
};
const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : "other"),
  );
const answerFor = (call: RunCall): unknown => {
  switch (call.op) {
    case "skills.list":
      return { skills: [SKILL], truncated: false };
    case "skills.setInvocation":
      return { results: [{ path: SKILL.path, ok: true }] };
    case "skills.search":
      return { results: [{ name: "n", source: "o/r", installs: 3, url: null }] };
    default:
      return { ok: true };
  }
};
function bed(answer: (call: RunCall) => unknown = answerFor) {
  const { pool, calls } = fakePool(answer);
  const clock = createFakeClock();
  const { logger } = captureLogger();
  const service = createSkillsService({
    audit: { append: () => {} },
    helpers: pool,
    projects: { covers: (owner, cwd) => owner === "u1" && cwd.startsWith("/w/api") },
    logger,
    clock,
  });
  return { service, calls, clock };
}
const caller = testCaller();
const project = "/w/api";

describe("skills.list", () => {
  it("runs the list in a helper with the folder as the run's, and returns the parsed answer", async () => {
    const { service, calls } = bed();
    expect(await service.list(caller, project)).toEqual({ skills: [SKILL], truncated: false });
    expect(calls[0]).toMatchObject({ op: "skills.list", params: {}, options: { cwd: project } });
    await service.list(caller);
    expect(calls[1]?.options).not.toHaveProperty("cwd");
  });

  it("refuses a folder the caller has no project in, before any helper starts", async () => {
    const { service, calls } = bed();
    expect(await codeOf(service.list(caller, "/etc"))).toBe("invalid_cwd");
    expect(calls).toHaveLength(0);
  });

  it("fails closed when the helper answers a field the contract does not list", async () => {
    const { service } = bed(() => ({ skills: [{ ...SKILL, body: "SECRET" }], truncated: false }));
    expect(await codeOf(service.list(caller))).toBe("helper_failed");
  });
});

describe("skills.setInvocation", () => {
  const items = [{ path: SKILL.path, disabled: true }];

  it("needs no step-up, passes the confirmation to the helper and the folder as the run's", async () => {
    const { service, calls } = bed();
    const result = await service.setInvocation(caller, { items, cwd: project, confirmProtected: true });
    expect(result).toEqual({ results: [{ path: SKILL.path, ok: true }] });
    expect(calls[0]).toMatchObject({
      op: "skills.setInvocation",
      params: { items, confirmProtected: true },
      options: { cwd: project },
    });
    expect(calls[0]?.params).not.toHaveProperty("cwd");
  });

  it("refuses a folder the caller has no project in", async () => {
    const { service, calls } = bed();
    expect(await codeOf(service.setInvocation(caller, { items, cwd: "/etc" }))).toBe("invalid_cwd");
    expect(calls).toHaveLength(0);
  });

  it("starts the second write only after the first ended (two switches never race on one file)", async () => {
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
    const service = createSkillsService({
      audit: { append: () => {} },
      helpers: pool,
      projects: { covers: () => true },
      logger: captureLogger().logger,
      clock: createFakeClock(),
    });
    const first = service.setInvocation(caller, { items });
    const second = service.setInvocation(caller, { items });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toHaveLength(1);
    gates[0]?.({ results: [{ path: SKILL.path, ok: true }] });
    await first;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toHaveLength(2);
    gates[1]?.({ results: [{ path: SKILL.path, ok: true }] });
    await second;
  });
});

describe("skills.search", () => {
  it("needs no step-up, trims the query and returns the parsed list", async () => {
    const { service, calls } = bed();
    expect(await service.search(caller, "  web  ")).toEqual({
      results: [{ name: "n", source: "o/r", installs: 3, url: null }],
    });
    expect(calls[0]).toMatchObject({ op: "skills.search", params: { query: "web" } });
  });

  it("refuses a result that carries a javascript: URL (fail closed)", async () => {
    const { service } = bed(() => ({
      results: [{ name: "n", source: "o", installs: 1, url: "javascript:1" }],
    }));
    expect(await codeOf(service.search(caller, "q"))).toBe("helper_failed");
  });
});

describe("skills.install (M7R140)", () => {
  const now = (clock: { now(): number }) => testCaller({ stepUpUntil: clock.now() + 60_000 });

  it("a global install without a live step-up is step_up_required and starts no helper", async () => {
    const { service, calls } = bed();
    expect(await codeOf(service.install(caller, { source: "o/r", scope: "global" }))).toBe(
      "step_up_required",
    );
    expect(calls).toHaveLength(0);
  });

  it("a global install with a step-up runs the helper without a folder and with room for the 5-minute deadline", async () => {
    const { service, calls, clock } = bed();
    expect(await service.install(now(clock), { source: "o/r", scope: "global" })).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ op: "skills.install", params: { source: "o/r", scope: "global" } });
    expect(calls[0]?.options.cwd).toBeUndefined();
    expect(calls[0]?.options.deadlineMs).toBe(330_000);
  });

  it("a project install needs a folder (bad_request), the confirmation (protected_path) and a folder of the caller (invalid_cwd)", async () => {
    const { service, calls } = bed();
    expect(
      await codeOf(service.install(caller, { source: "o/r", scope: "project", confirmProtected: true })),
    ).toBe("bad_request");
    expect(await codeOf(service.install(caller, { source: "o/r", scope: "project", cwd: project }))).toBe(
      "protected_path",
    );
    expect(
      await codeOf(
        service.install(caller, { source: "o/r", scope: "project", cwd: "/etc", confirmProtected: true }),
      ),
    ).toBe("invalid_cwd");
    expect(calls).toHaveLength(0);
  });

  it("a confirmed project install needs no step-up and runs in the project", async () => {
    const { service, calls } = bed();
    await service.install(caller, { source: "o/r", scope: "project", cwd: project, confirmProtected: true });
    expect(calls[0]).toMatchObject({
      op: "skills.install",
      params: { source: "o/r", scope: "project", confirmProtected: true },
      options: { cwd: project },
    });
  });

  it("passes the helper's refusal of an untrusted project on as forbidden", async () => {
    const { service } = bed(() => new PapError("forbidden"));
    expect(
      await codeOf(
        service.install(caller, { source: "o/r", scope: "project", cwd: project, confirmProtected: true }),
      ),
    ).toBe("forbidden");
  });

  it("runs installs one at a time", async () => {
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
    const clock = createFakeClock();
    const service = createSkillsService({
      audit: { append: () => {} },
      helpers: pool,
      projects: { covers: () => true },
      logger: captureLogger().logger,
      clock,
    });
    const owner = now(clock);
    const a = service.install(owner, { source: "o/a", scope: "global" });
    const b = service.install(owner, { source: "o/b", scope: "global" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toHaveLength(1);
    gates[0]?.({ ok: true });
    await a;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toHaveLength(2);
    gates[1]?.({ ok: true });
    await b;
  });
});
