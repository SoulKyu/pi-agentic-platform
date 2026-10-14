import { HELPER_OPS, type McpTestOutcome, PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { testCaller } from "../../testing/caller.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { fakePool, type RunCall } from "../models/testing/bed.ts";
import { createMcpService } from "./service.ts";
import { TEST_RESULTS_MAX_PER_OWNER } from "./test-results.ts";

const connected: McpTestOutcome = {
  state: "connected",
  tools: ["echo", "ping"],
  toolsTruncated: false,
  message: null,
};
const server = (name: string, scope: "global" | "project" = "global") => ({
  name,
  scope,
  kind: "stdio",
  enabled: true,
  exposure: "codemode",
  target: "node s.js",
  envNames: [],
  headerNames: [],
  commandFields: [],
  variables: [],
  oauth: false,
  toolExposureCount: 0,
  state: "on",
  lastTest: null,
  problem: null,
});
const overview = {
  global: { path: "/a/mcp.json", problem: null, trusted: null, servers: [server("fix")] },
  project: {
    path: "/w/api/.pi/mcp.json",
    problem: null,
    trusted: true,
    servers: [server("fix", "project")],
  },
  codemode: { autoEnable: true, source: "default" },
  settings: null,
  codemodeBuiltinOff: false,
};
const confirmed = (now: number, userId = "u1") => testCaller({ userId, stepUpUntil: now + 60_000 });
const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : "other"),
  );

function bed(answer: (call: RunCall) => unknown = () => connected) {
  const { pool, calls } = fakePool((call) => (call.op === "mcp.overview" ? overview : answer(call)));
  const clock = createFakeClock();
  const { logger, lines } = captureLogger();
  const service = createMcpService({
    helpers: pool,
    projects: { covers: (owner, cwd) => owner !== "u9" && cwd.startsWith("/w/api") },
    logger,
    clock,
    testDeadlineMs: 5_000,
  });
  return { service, calls, clock, lines };
}

describe("mcp.test: the service", () => {
  it("asks for the password step-up before anything else, and starts no helper without it", async () => {
    const { service, calls } = bed();
    expect(await codeOf(service.test(testCaller(), { scope: "global", name: "fix" }))).toBe(
      "step_up_required",
    );
    expect(await codeOf(service.test(testCaller({ kind: "token" }), { scope: "global", name: "fix" }))).toBe(
      "step_up_required",
    );
    expect(calls).toHaveLength(0);
  });

  it("runs the helper with the name, scope and the module's deadline, and stamps the result with the clock", async () => {
    const { service, calls, clock } = bed();
    clock.advance(1234);
    const result = await service.test(confirmed(clock.now()), { scope: "global", name: "fix" });
    expect(result).toEqual({ ...connected, at: clock.now() });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      op: "mcp.test",
      params: { scope: "global", name: "fix", deadlineMs: 5_000 },
    });
    expect(calls[0]?.options.cwd).toBeUndefined();
    // The helper needs the session start and the shutdown on top of the Test's own wait.
    expect(calls[0]?.options.deadlineMs).toBe(5_000 + 15_000);
    expect(HELPER_OPS["mcp.test"].params.safeParse(calls[0]?.params).success).toBe(true);
  });

  it("needs a cwd for a project server, covered by the caller's projects (invalid_cwd otherwise)", async () => {
    const { service, calls, clock } = bed();
    const caller = confirmed(clock.now());
    expect(await codeOf(service.test(caller, { scope: "project", name: "fix" }))).toBe("bad_request");
    expect(await codeOf(service.test(caller, { scope: "project", name: "fix", cwd: "/etc" }))).toBe(
      "invalid_cwd",
    );
    expect(await codeOf(service.test(caller, { scope: "global", name: "fix", cwd: "/etc" }))).toBe(
      "invalid_cwd",
    );
    expect(calls).toHaveLength(0);
    await service.test(caller, { scope: "project", name: "fix", cwd: "/w/api" });
    expect(calls[0]?.options.cwd).toBe("/w/api");
  });

  it("answers forbidden for an untrusted project (the helper refuses it, M7R94)", async () => {
    const { service, clock } = bed(() => new PapError("forbidden"));
    expect(
      await codeOf(service.test(confirmed(clock.now()), { scope: "project", name: "fix", cwd: "/w/api" })),
    ).toBe("forbidden");
  });

  it("refuses a helper answer the contract does not list, with nothing of it logged", async () => {
    const { service, clock, lines } = bed(() => ({ ...connected, stderr: "sk-SECRET-STDERR" }));
    expect(await codeOf(service.test(confirmed(clock.now()), { scope: "global", name: "fix" }))).toBe(
      "helper_failed",
    );
    expect(JSON.stringify(lines)).not.toContain("sk-SECRET-STDERR");
  });
});

describe("mcp.test: the last results (M7R97)", () => {
  it("shows the last Test of a server in the overview, by owner, scope and name", async () => {
    const { service, clock } = bed((call) =>
      (call.params as { scope: string }).scope === "global"
        ? connected
        : { state: "failed", tools: [], toolsTruncated: false, message: "boom" },
    );
    const caller = confirmed(clock.now());
    const start = clock.now();
    expect((await service.overview(caller)).global.servers[0]?.lastTest).toBeNull();
    await service.test(caller, { scope: "global", name: "fix" });
    await clock.advance(10);
    await service.test(caller, { scope: "project", name: "fix", cwd: "/w/api" });
    const seen = await service.overview(caller, "/w/api");
    expect(seen.global.servers[0]?.lastTest).toEqual({ at: start, ok: true, state: "connected", tools: 2 });
    expect(seen.project?.servers[0]?.lastTest).toEqual({
      at: start + 10,
      ok: false,
      state: "failed",
      tools: null,
    });
    // Another owner has none of them.
    const other = await service.overview(confirmed(clock.now(), "u2"));
    expect(other.global.servers[0]?.lastTest).toBeNull();
  });

  it("returns the result of a 401st name even though it is not kept", async () => {
    const { service, clock } = bed();
    const caller = confirmed(clock.now());
    for (let i = 0; i < TEST_RESULTS_MAX_PER_OWNER; i += 1)
      await service.test(caller, { scope: "global", name: `s${i}` });
    expect((await service.test(caller, { scope: "global", name: "extra" })).state).toBe("connected");
  });

  it("does not keep the result of a Test that a removal overtook, but still returns it (MC45 M2)", async () => {
    let finish: (value: unknown) => void = () => {};
    const slow = new Promise((resolve) => (finish = resolve));
    const { service, clock } = bed((call) =>
      call.op === "mcp.remove" ? { index: 0, entry: "{}" } : call.op === "mcp.test" ? slow : connected,
    );
    const caller = confirmed(clock.now());
    const running = service.test(caller, { scope: "global", name: "fix" });
    await service.remove(caller, { scope: "global", name: "fix" });
    finish(connected);
    expect((await running).state).toBe("connected");
    expect((await service.overview(caller)).global.servers[0]?.lastTest).toBeNull();
    // A Test that starts after the removal is kept.
    await service.test(caller, { scope: "global", name: "fix" });
    expect((await service.overview(caller)).global.servers[0]?.lastTest).toMatchObject({
      state: "connected",
    });
  });
});
