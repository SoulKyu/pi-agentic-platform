import { describe, expect, it } from "vitest";
import { shellFactsOf } from "./shell-facts.ts";

const SETTINGS = { getShellCommandPrefix: () => undefined, getShellPath: () => undefined };
const PLAIN = {
  commandPrefix: undefined,
  shellPath: undefined,
  startupFile: false,
  cdPath: false,
  gitEnv: false,
  rgConfig: false,
  path: "/usr/bin",
};

describe("shellFactsOf", () => {
  it("reads nothing special from a plain environment", () => {
    expect(shellFactsOf(SETTINGS, { PATH: "/usr/bin" })).toEqual(PLAIN);
  });

  it("reads the settings at each call", () => {
    let prefix: string | undefined = undefined;
    const settings = { getShellCommandPrefix: () => prefix, getShellPath: () => "/bin/zsh" };
    expect(shellFactsOf(settings, { PATH: "/usr/bin" }).commandPrefix).toBeUndefined();
    prefix = "source ~/.bash_aliases";
    expect(shellFactsOf(settings, { PATH: "/usr/bin" })).toMatchObject({
      commandPrefix: "source ~/.bash_aliases",
      shellPath: "/bin/zsh",
    });
  });

  it.each([
    ["BASH_ENV", "startupFile"],
    ["ENV", "startupFile"],
    ["CDPATH", "cdPath"],
    ["GIT_DIR", "gitEnv"],
    ["GIT_WORK_TREE", "gitEnv"],
    ["GIT_COMMON_DIR", "gitEnv"],
    ["GIT_OBJECT_DIRECTORY", "gitEnv"],
    ["GIT_INDEX_FILE", "gitEnv"],
    ["RIPGREP_CONFIG_PATH", "rgConfig"],
  ] as const)("%s sets %s", (name, fact) => {
    expect(shellFactsOf(SETTINGS, { PATH: "/usr/bin", [name]: "" })).toEqual({ ...PLAIN, [fact]: true });
  });
});
