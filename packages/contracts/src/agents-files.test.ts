import { describe, expect, it } from "vitest";
import { AGENT_FILE_LIMITS, AgentFilePath } from "./agents-files.ts";
import { agentsVmMethods } from "./agents-vm-methods.ts";
import { QUARANTINE_STEPS, QuarantineResult } from "./agents-safety.ts";
import { methods } from "./methods.ts";
import { METHOD_IDEMPOTENT } from "./methods-idempotent.ts";
import { TOKEN_PERMISSIONS } from "./auth.ts";

describe("AGENT_FILE_LIMITS", () => {
  it("is 1 MiB per file and 32 files", () => {
    expect(AGENT_FILE_LIMITS).toEqual({ maxBytes: 1_048_576, maxFiles: 32 });
  });
});

describe("AgentFilePath", () => {
  it.each([".kube/config", ".config/gmail/token.json", "a", "a/b/c/d/e/f/g/h", "x-y_z.1"])(
    "accepts %s",
    (path) => {
      expect(AgentFilePath.safeParse(path).success).toBe(true);
    },
  );

  it.each([
    ["a parent segment", "../x"],
    ["a middle parent segment", "a/../b"],
    ["an absolute path", "/etc/passwd"],
    ["an empty segment", "a//b"],
    ["a trailing slash", "a/"],
    ["a dot", "."],
    ["a middle dot", "a/./b"],
    ["nine segments", "a/b/c/d/e/f/g/h/i"],
    ["an empty string", ""],
    ["a space", "a b"],
    ["a backslash", "a\\b"],
    ["a control character", "a\u0000b"],
    ["a segment of 129 characters", "a".repeat(129)],
    ["513 characters", `${"a".repeat(100)}/`.repeat(5) + "a".repeat(13)],
  ])("refuses %s", (_name, path) => {
    expect(AgentFilePath.safeParse(path).success).toBe(false);
  });
});

describe("agents.files methods", () => {
  it("are agents:admin, browser only, and in the catalogue with their idempotency", () => {
    for (const name of ["agents.files.list", "agents.files.remove"] as const) {
      expect(agentsVmMethods[name].permission).toBe("agents:admin");
      expect(methods[name].permission).toBe("agents:admin");
      expect(TOKEN_PERMISSIONS).not.toContain("agents:admin");
    }
    expect(METHOD_IDEMPOTENT["agents.files.list"]).toBe(true);
    expect(METHOD_IDEMPOTENT["agents.files.remove"]).toBe(false);
    expect(methods["agents.files.remove"].idempotent).toBe(false);
  });

  it("decode a bounded path and refuse an unknown field", () => {
    const params = agentsVmMethods["agents.files.remove"].params;
    expect(params.safeParse({ agentId: "atlas-0000", path: ".kube/config" }).success).toBe(true);
    expect(params.safeParse({ agentId: "atlas-0000", path: "../x" }).success).toBe(false);
    expect(params.safeParse({ agentId: "atlas-0000", path: "x", extra: 1 }).success).toBe(false);
  });
});

describe("quarantine and the files", () => {
  it("has a files step before memory, and an answer that can list the paths", () => {
    expect(QUARANTINE_STEPS).toContain("files");
    expect(QUARANTINE_STEPS.indexOf("files")).toBeLessThan(QUARANTINE_STEPS.indexOf("memory"));
    const base = {
      secrets: [],
      vaultNames: [],
      tasksCancelled: 0,
      errors: [{ step: "files", code: "failed" }],
    };
    expect(QuarantineResult.safeParse({ ...base, filePaths: [".kube/config"] }).success).toBe(true);
    expect(QuarantineResult.safeParse({ ...base, filePaths: ["../x"] }).success).toBe(false);
    expect(QuarantineResult.safeParse(base).success).toBe(true);
  });
});
