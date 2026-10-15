import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, type ConfigInput } from "./config.ts";

let cwd: string;
let base: ConfigInput;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pap-config-m9-"));
  base = {
    argv: [],
    env: {},
    cwd,
    homedir: "/home/u",
    totalMemMb: 16_384,
    piHostEntry: "/x/main.js",
    piHostExecArgv: [],
    staticRoot: null,
  };
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("PAP_TEST_GIT_PROTOCOLS (M9R10)", () => {
  it("is refused without PAP_TEST_PROVIDER_SCRIPT", () => {
    expect(() => loadConfig({ ...base, env: { PAP_TEST_GIT_PROTOCOLS: "file" } })).toThrow(ConfigError);
  });
  it("is honoured next to the scripted provider", () => {
    const env = { PAP_TEST_GIT_PROTOCOLS: "file", PAP_TEST_PROVIDER_SCRIPT: "/x/script.js" };
    expect(loadConfig({ ...base, env }).testGitProtocols).toBe("file");
  });
  it("is null by default", () => {
    expect(loadConfig(base).testGitProtocols).toBeNull();
  });
  it("accepts only protocol names", () => {
    const env = { PAP_TEST_GIT_PROTOCOLS: "file:ext", PAP_TEST_PROVIDER_SCRIPT: "/x/script.js" };
    expect(() => loadConfig({ ...base, env })).toThrow(ConfigError);
  });
});
