import { describe, expect, it } from "vitest";
import {
  DaemonToHelper,
  ERROR_CODES,
  HELPER_CODES,
  HELPER_OPS,
  HelperToDaemon,
  helperErrorCode,
  type HelperCode,
} from "./index.ts";

const run = { type: "helper_run", op: "ping", agentDir: "/a", papHome: "/p", params: {} };

describe("DaemonToHelper", () => {
  it("accepts the run, answer and cancel records", () => {
    expect(DaemonToHelper.safeParse(run).success).toBe(true);
    expect(DaemonToHelper.safeParse({ ...run, cwd: "/work" }).success).toBe(true);
    expect(DaemonToHelper.safeParse({ type: "helper_answer", promptId: "p1", value: null }).success).toBe(
      true,
    );
    expect(DaemonToHelper.safeParse({ type: "helper_cancel" }).success).toBe(true);
  });

  it("refuses a relative agentDir, a relative cwd and a NUL in a path", () => {
    expect(DaemonToHelper.safeParse({ ...run, agentDir: "agent" }).success).toBe(false);
    expect(DaemonToHelper.safeParse({ ...run, papHome: "../p" }).success).toBe(false);
    expect(DaemonToHelper.safeParse({ ...run, cwd: "work" }).success).toBe(false);
    expect(DaemonToHelper.safeParse({ ...run, agentDir: "/a\0b" }).success).toBe(false);
  });

  it("refuses an extra key on every record", () => {
    expect(DaemonToHelper.safeParse({ ...run, extra: 1 }).success).toBe(false);
    expect(DaemonToHelper.safeParse({ type: "helper_cancel", extra: 1 }).success).toBe(false);
    expect(
      DaemonToHelper.safeParse({ type: "helper_answer", promptId: "p", value: "x", extra: 1 }).success,
    ).toBe(false);
  });

  it("bounds an answer at 65536 characters and a prompt id at 64", () => {
    const answer = (value: string, promptId = "p") => ({ type: "helper_answer", promptId, value });
    expect(DaemonToHelper.safeParse(answer("x".repeat(65_536))).success).toBe(true);
    expect(DaemonToHelper.safeParse(answer("x".repeat(65_537))).success).toBe(false);
    expect(DaemonToHelper.safeParse(answer("x", "p".repeat(65))).success).toBe(false);
    expect(DaemonToHelper.safeParse(answer("x", "")).success).toBe(false);
  });
});

describe("HelperToDaemon", () => {
  it("parses both helper_done shapes, an event and a prompt", () => {
    expect(HelperToDaemon.safeParse({ type: "helper_done", ok: true, result: { a: 1 } }).success).toBe(true);
    expect(HelperToDaemon.safeParse({ type: "helper_done", ok: false, code: "failed" }).success).toBe(true);
    expect(HelperToDaemon.safeParse({ type: "helper_event", event: 1 }).success).toBe(true);
    expect(HelperToDaemon.safeParse({ type: "helper_prompt", promptId: "p", prompt: {} }).success).toBe(true);
  });

  it("refuses a detail of 257 characters, an unknown code and an extra key", () => {
    const failed = { type: "helper_done", ok: false, code: "failed" };
    expect(HelperToDaemon.safeParse({ ...failed, detail: "d".repeat(256) }).success).toBe(true);
    expect(HelperToDaemon.safeParse({ ...failed, detail: "d".repeat(257) }).success).toBe(false);
    expect(HelperToDaemon.safeParse({ ...failed, code: "nope" }).success).toBe(false);
    expect(HelperToDaemon.safeParse({ ...failed, extra: 1 }).success).toBe(false);
  });

  it("refuses a record that is not a helper record", () => {
    for (const raw of [null, "x", 1, [], {}, { type: "response" }, { type: "helper_done" }])
      expect(HelperToDaemon.safeParse(raw).success).toBe(false);
  });
});

describe("helperErrorCode", () => {
  it("maps every helper code to a real error code", () => {
    for (const code of HELPER_CODES) expect(ERROR_CODES).toContain(helperErrorCode(code));
  });

  it("maps every helper code to the client code of the same name, or the generic ones", () => {
    const expected: Record<HelperCode, string> = {
      bad_params: "bad_request",
      unknown_op: "internal",
      not_found: "not_found",
      conflict: "conflict",
      project_scope: "project_scope",
      project_untrusted: "forbidden",
      protected_path: "protected_path",
      config_invalid: "config_invalid",
      config_path_refused: "config_path_refused",
      config_hard_link: "config_hard_link",
      failed: "helper_failed",
    };
    for (const [code, mapped] of Object.entries(expected))
      expect(helperErrorCode(code as HelperCode)).toBe(mapped);
  });
});

describe("HELPER_OPS (models)", () => {
  it("declares strict params for the four models operations", () => {
    expect(HELPER_OPS["models.overview"].params.safeParse({}).success).toBe(true);
    expect(HELPER_OPS["models.overview"].params.safeParse({ cwd: "/x" }).success).toBe(false);
    expect(HELPER_OPS["models.setDefault"].params.safeParse({ provider: "p", modelId: "m" }).success).toBe(
      true,
    );
    expect(HELPER_OPS["models.setDefault"].params.safeParse({ provider: "p" }).success).toBe(false);
    expect(HELPER_OPS["models.setDefaultThinking"].params.safeParse({ level: "low" }).success).toBe(true);
    expect(HELPER_OPS["models.setDefaultThinking"].params.safeParse({ level: "x" }).success).toBe(false);
    expect(HELPER_OPS["models.refreshCatalog"].params.safeParse({}).success).toBe(true);
    expect(
      HELPER_OPS["models.refreshCatalog"].result.safeParse({
        changed: false,
        offline: true,
        failedProviders: [],
      }).success,
    ).toBe(true);
    expect(HELPER_OPS["models.refreshCatalog"].result.safeParse({ changed: false }).success).toBe(false);
  });
});
