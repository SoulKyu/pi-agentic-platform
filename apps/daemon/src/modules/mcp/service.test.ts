import { HELPER_OPS, PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { testCaller } from "../../testing/caller.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { fakePool } from "../models/testing/bed.ts";
import { createMcpService } from "./service.ts";

const server = {
  name: "docs",
  scope: "global",
  kind: "http",
  enabled: true,
  exposure: "codemode",
  target: "https://h.example/mcp",
  envNames: [],
  headerNames: ["Authorization"],
  commandFields: [],
  variables: [],
  oauth: false,
  toolExposureCount: 0,
  state: "on",
  lastTest: null,
  problem: null,
};
const overview = {
  global: { path: "/a/mcp.json", problem: null, trusted: null, servers: [server] },
  project: null,
  codemode: { autoEnable: true, source: "default" },
  settings: null,
  codemodeBuiltinOff: false,
};
const caller = testCaller();
const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : "other"),
  );

function bed(answer: () => unknown, roots = ["/w/api"]) {
  const { pool, calls } = fakePool(answer);
  const { logger, lines } = captureLogger();
  const service = createMcpService({
    helpers: pool,
    projects: {
      covers: (ownerId, cwd) => ownerId === "u1" && roots.some((r) => cwd === r || cwd.startsWith(`${r}/`)),
    },
    logger,
    clock: createFakeClock(),
  });
  return { service, calls, lines };
}

describe("mcp service: overview", () => {
  it("asks the helper once with no params and returns what the contract accepts", async () => {
    const { service, calls } = bed(() => overview);
    expect(await service.overview(caller)).toEqual(overview);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: "mcp.overview", params: {} });
    expect(calls[0]?.options.cwd).toBeUndefined();
    expect(calls[0]?.options.deadlineMs).toBe(30_000);
    expect(HELPER_OPS["mcp.overview"].result.safeParse(overview).success).toBe(true);
  });

  it("passes a cwd the caller has a project in, and refuses any other with invalid_cwd before a helper starts", async () => {
    const { service, calls } = bed(() => overview);
    await service.overview(caller, "/w/api/src");
    expect(calls[0]?.options.cwd).toBe("/w/api/src");
    expect(await codeOf(service.overview(caller, "/etc"))).toBe("invalid_cwd");
    expect(await codeOf(service.overview(testCaller({ userId: "u2" }), "/w/api"))).toBe("invalid_cwd");
    expect(calls).toHaveLength(1);
  });

  it("refuses a result carrying an extra field as helper_failed and logs no content", async () => {
    const poisoned = {
      ...overview,
      global: { ...overview.global, servers: [{ ...server, env: { A: "sk-SECRET-VALUE" } }] },
    };
    const { service, lines } = bed(() => poisoned);
    expect(await codeOf(service.overview(caller))).toBe("helper_failed");
    expect(JSON.stringify(lines)).not.toContain("sk-SECRET-VALUE");
    expect(lines.some((line) => line.msg === "mcp_helper_result_invalid")).toBe(true);
  });

  it("refuses a result that is not an overview", async () => {
    for (const bad of [null, "text", [], { global: 1 }]) {
      const { service } = bed(() => bad);
      expect(await codeOf(service.overview(caller))).toBe("helper_failed");
    }
  });

  it("passes a helper failure through as the pool's error", async () => {
    const { service } = bed(() => new PapError("helper_failed"));
    expect(await codeOf(service.overview(caller))).toBe("helper_failed");
  });
});
