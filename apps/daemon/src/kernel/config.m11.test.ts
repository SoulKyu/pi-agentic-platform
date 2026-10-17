import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, type ConfigInput } from "./config.ts";

const input = (env: NodeJS.ProcessEnv): ConfigInput => ({
  argv: [],
  env,
  cwd: "/tmp",
  homedir: "/home/u",
  totalMemMb: 16_384,
  piHostEntry: "/x/main.js",
  piHostExecArgv: [],
  staticRoot: null,
});

describe("PAP_BWRAP (M11R21)", () => {
  it("is undefined when unset or empty", () => {
    expect(loadConfig(input({})).bwrapOverride).toBeUndefined();
    expect(loadConfig(input({ PAP_BWRAP: "" })).bwrapOverride).toBeUndefined();
  });

  it("keeps an absolute path", () => {
    expect(loadConfig(input({ PAP_BWRAP: "/opt/bin/bwrap" })).bwrapOverride).toBe("/opt/bin/bwrap");
  });

  it.each(["bin/bwrap", "bwrap", "./bwrap", "~/bwrap"])(
    "stops the daemon at boot for %s, naming the variable",
    (value) => {
      let error: unknown;
      try {
        loadConfig(input({ PAP_BWRAP: value }));
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain("PAP_BWRAP");
      expect((error as Error).message).not.toContain(value);
    },
  );
});
