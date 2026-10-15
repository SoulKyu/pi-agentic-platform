import { describe, expect, it } from "vitest";
import { classifyStderr, forgeEnv } from "./cli.ts";

const HOSTILE = {
  GH_TOKEN: "t1",
  GITHUB_TOKEN: "t2",
  GH_ENTERPRISE_TOKEN: "t3",
  GH_HOST: "evil.example",
  SSH_AUTH_SOCK: "/tmp/agent",
  ANTHROPIC_API_KEY: "k",
  PAP_SECRET: "s",
  NODE_OPTIONS: "--require /x",
  GIT_DIR: "/x",
  OTHER: "o",
  GH_CONFIG_DIR: "/home/o/.config/gh",
  XDG_CONFIG_HOME: "/home/o/.config",
  HTTPS_PROXY: "http://proxy:3128",
  PATH: "/usr/bin:relative:/opt/bin:.",
};

describe("forgeEnv", () => {
  const env = forgeEnv(HOSTILE, "/pap/tmp/forge");
  it("passes no token, agent, provider key, host override, loader or git redirection", () => {
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GH_HOST",
      "SSH_AUTH_SOCK",
      "ANTHROPIC_API_KEY",
      "PAP_SECRET",
      "NODE_OPTIONS",
      "GIT_DIR",
      "OTHER",
    ])
      expect(env).not.toHaveProperty(key);
  });
  it("keeps the CLI's own config, the proxy and the absolute PATH entries", () => {
    expect(env.GH_CONFIG_DIR).toBe("/home/o/.config/gh");
    expect(env.XDG_CONFIG_HOME).toBe("/home/o/.config");
    expect(env.HTTPS_PROXY).toBe("http://proxy:3128");
    expect(env.PATH).toBe("/usr/bin:/opt/bin");
  });
  it("sets the quiet, promptless values and the ceiling at the forge folder's parent", () => {
    expect(env).toMatchObject({
      LC_ALL: "C",
      NO_COLOR: "1",
      CLICOLOR: "0",
      PAGER: "cat",
      GH_PAGER: "cat",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
      GH_SPINNER_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CEILING_DIRECTORIES: "/pap/tmp",
    });
  });
});

describe("classifyStderr", () => {
  it.each([
    ["To get started with GitHub CLI, please run:  gh auth login", "not_signed_in"],
    ["You are not logged into any GitHub hosts", "not_signed_in"],
    ["authentication required", "not_signed_in"],
    ["HTTP 401: Bad credentials (https://api.github.com/graphql)", "not_signed_in"],
    ["GraphQL: Could not resolve to a Repository with the name 'o/r'.", "not_found"],
    ["HTTP 404: Not Found", "not_found"],
    ["pull request not found", "not_found"],
    ["something else broke", "failed"],
    ["", "failed"],
  ])("%s -> %s", (stderr, outcome) => {
    expect(classifyStderr(stderr)).toBe(outcome);
  });
});
