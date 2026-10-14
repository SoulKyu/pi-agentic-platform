import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { testCaller } from "../../testing/caller.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { fakePool, type RunCall } from "../models/testing/bed.ts";
import { createMcpService } from "./service.ts";
import { UNDO_MAX_PER_OWNER, UNDO_TTL_MS } from "./undo.ts";

const SECRET_ENTRY = '{"command":"x","env":{"K":"sk-SECRET-IN-ENTRY"}}';
const clock = () => createFakeClock();
const confirmed = (now: number) => testCaller({ stepUpUntil: now + 60_000 });
const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : "other"),
  );

function bed(answer: (call: RunCall) => unknown = () => ({ ok: true })) {
  const { pool, calls } = fakePool(answer);
  const fake = clock();
  const { logger } = captureLogger();
  const service = createMcpService({
    helpers: pool,
    projects: { covers: (owner, cwd) => owner === "u1" && cwd.startsWith("/w/api") },
    logger,
    clock: fake,
  });
  return { service, calls, clock: fake };
}
const caller = testCaller();
const project = "/w/api";

describe("mcp writes: the project confirmation (M7R133)", () => {
  it("refuses a project row without confirmProtected as protected_path, before any helper starts", async () => {
    const { service, calls } = bed();
    const rows = [{ scope: "project" as const, name: "a" }];
    expect(await codeOf(service.setEnabled(caller, { servers: rows, enabled: false, cwd: project }))).toBe(
      "protected_path",
    );
    expect(
      await codeOf(
        service.setExposure(caller, { scope: "project", name: "a", exposure: "direct", cwd: project }),
      ),
    ).toBe("protected_path");
    expect(await codeOf(service.setInProject(caller, { name: "a", enabled: false, cwd: project }))).toBe(
      "protected_path",
    );
    expect(await codeOf(service.remove(caller, { scope: "project", name: "a", cwd: project }))).toBe(
      "protected_path",
    );
    expect(
      await codeOf(
        service.add(caller, { scope: "project", name: "a", entry: { command: "x" }, cwd: project }),
      ),
    ).toBe("protected_path");
    expect(calls).toHaveLength(0);
  });

  it("passes a confirmed project write with the cwd as the run's folder and no cwd in the params", async () => {
    const { service, calls } = bed();
    await service.setInProject(caller, { name: "a", enabled: false, cwd: project, confirmProtected: true });
    expect(calls[0]).toMatchObject({
      op: "mcp.setInProject",
      params: { name: "a", enabled: false, confirmProtected: true },
      options: { cwd: project },
    });
    expect(calls[0]?.params).not.toHaveProperty("cwd");
  });

  it("needs no confirmation and no step-up for a global switch, exposure or removal", async () => {
    const { service, calls } = bed((call) =>
      call.op === "mcp.remove"
        ? { index: 0, entry: "{}" }
        : call.op === "mcp.setEnabled"
          ? { results: [] }
          : { ok: true },
    );
    await service.setEnabled(caller, { servers: [{ scope: "global", name: "a" }], enabled: false });
    await service.setExposure(caller, { scope: "global", name: "a", exposure: "hidden" });
    await service.remove(caller, { scope: "global", name: "a" });
    expect(calls.map((call) => call.op)).toEqual(["mcp.setEnabled", "mcp.setExposure", "mcp.remove"]);
  });

  it("refuses a project target without a cwd (bad_request) and a cwd the caller has no project in (invalid_cwd)", async () => {
    const { service, calls } = bed();
    const rows = [{ scope: "project" as const, name: "a" }];
    expect(
      await codeOf(service.setEnabled(caller, { servers: rows, enabled: false, confirmProtected: true })),
    ).toBe("bad_request");
    expect(
      await codeOf(
        service.setEnabled(caller, { servers: rows, enabled: false, cwd: "/etc", confirmProtected: true }),
      ),
    ).toBe("invalid_cwd");
    expect(
      await codeOf(
        service.setEnabled(testCaller({ userId: "u2" }), {
          servers: rows,
          enabled: false,
          cwd: project,
          confirmProtected: true,
        }),
      ),
    ).toBe("invalid_cwd");
    expect(calls).toHaveLength(0);
  });
});

describe("mcp.add", () => {
  it("a global add needs a live step-up and a project add does not", async () => {
    const { service, calls, clock: fake } = bed();
    const params = { scope: "global" as const, name: "a", entry: { command: "x" } };
    expect(await codeOf(service.add(caller, params))).toBe("step_up_required");
    expect(await codeOf(service.add(testCaller({ stepUpUntil: fake.now() - 1 }), params))).toBe(
      "step_up_required",
    );
    expect(calls).toHaveLength(0);
    await service.add(confirmed(fake.now()), params);
    await service.add(caller, { ...params, scope: "project", cwd: project, confirmProtected: true });
    expect(calls.map((call) => call.op)).toEqual(["mcp.add", "mcp.add"]);
  });

  it("a token never steps up: a global add by a token is step_up_required", async () => {
    const { service } = bed();
    expect(
      await codeOf(
        service.add(testCaller({ kind: "token" }), { scope: "global", name: "a", entry: { command: "x" } }),
      ),
    ).toBe("step_up_required");
  });
});

describe("mcp.remove and mcp.undo (M7R90)", () => {
  const removal = () => ({ index: 2, entry: SECRET_ENTRY });

  it("answers a token and an expiry only: the entry text stays in the daemon", async () => {
    const { service } = bed(removal);
    const result = await service.remove(caller, { scope: "global", name: "a" });
    expect(Object.keys(result).sort()).toEqual(["expiresInMs", "token"]);
    expect(result.expiresInMs).toBe(UNDO_TTL_MS);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("undo hands the kept text and index back to the helper, once; a second undo is not_found", async () => {
    const {
      service,
      calls,
      clock: fake,
    } = bed((call) => (call.op === "mcp.remove" ? removal() : { ok: true }));
    const { token } = await service.remove(caller, { scope: "global", name: "a" });
    await service.undo(confirmed(fake.now()), { token });
    expect(calls[1]).toMatchObject({
      op: "mcp.restore",
      params: { scope: "global", name: "a", index: 2, entry: SECRET_ENTRY },
    });
    expect(await codeOf(service.undo(confirmed(fake.now()), { token }))).toBe("not_found");
  });

  it("a global undo needs a step-up, a project undo the confirmation and its folder", async () => {
    const {
      service,
      calls,
      clock: fake,
    } = bed((call) => (call.op === "mcp.remove" ? removal() : { ok: true }));
    const global = await service.remove(caller, { scope: "global", name: "g" });
    expect(await codeOf(service.undo(caller, { token: global.token }))).toBe("step_up_required");
    const local = await service.remove(caller, {
      scope: "project",
      name: "p",
      cwd: project,
      confirmProtected: true,
    });
    expect(await codeOf(service.undo(caller, { token: local.token }))).toBe("protected_path");
    expect(calls.filter((call) => call.op === "mcp.restore")).toHaveLength(0);
    await service.undo(caller, { token: local.token, confirmProtected: true });
    expect(calls.at(-1)).toMatchObject({ op: "mcp.restore", options: { cwd: project } });
    await service.undo(confirmed(fake.now()), { token: global.token });
  });

  it("another owner's token is not_found, and so is an expired one (60 s on the fake clock)", async () => {
    const { service, clock: fake } = bed(removal);
    const { token } = await service.remove(caller, { scope: "global", name: "a" });
    expect(
      await codeOf(service.undo(testCaller({ userId: "u2", stepUpUntil: fake.now() + 1000 }), { token })),
    ).toBe("not_found");
    await fake.advance(UNDO_TTL_MS);
    expect(await codeOf(service.undo(confirmed(fake.now()), { token }))).toBe("not_found");
  });

  it("refuses the 101st pending removal with limit_reached and does not start a helper for it", async () => {
    const { service, calls } = bed(removal);
    for (let i = 0; i < UNDO_MAX_PER_OWNER; i++)
      await service.remove(caller, { scope: "global", name: `s${i}` });
    expect(await codeOf(service.remove(caller, { scope: "global", name: "one-more" }))).toBe("limit_reached");
    expect(calls).toHaveLength(UNDO_MAX_PER_OWNER);
  });

  it("keeps the record when the helper refused the restore (conflict), so the undo can be tried again", async () => {
    let restores = 0;
    const { service, clock: fake } = bed((call) => {
      if (call.op === "mcp.remove") return removal();
      restores += 1;
      return restores === 1 ? new PapError("conflict") : { ok: true };
    });
    const { token } = await service.remove(caller, { scope: "global", name: "a" });
    expect(await codeOf(service.undo(confirmed(fake.now()), { token }))).toBe("conflict");
    expect(await codeOf(service.undo(confirmed(fake.now()), { token }))).toBe("resolved");
  });
});

describe("mcp.setCodemode", () => {
  it("runs the code mode operation with the params as given", async () => {
    const view = { choice: "always", mode: "only", inlineBudget: 10 };
    const { service, calls } = bed(() => view);
    expect(await service.setCodemode(caller, { choice: "always" })).toEqual(view);
    expect(calls[0]).toMatchObject({ op: "mcp.codemode", params: { choice: "always" } });
    expect(calls[0]?.options.cwd).toBeUndefined();
  });
});
