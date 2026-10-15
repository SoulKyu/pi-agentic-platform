import { isNeverPassedEnvKey } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { gitArgs, gitEnv, KEPT, KEPT_REMOTE } from "./exec.ts";

const pairs = (args: string[]): string[] => args.flatMap((arg, at) => (args[at - 1] === "-c" ? [arg] : []));

describe("the remote profile (M9R10)", () => {
  it("drops protocol.allow=never and credential.helper=, keeps the rest in order, ends with the push pairs", () => {
    const local = pairs(gitArgs("/r", ["push"]));
    const remote = pairs(gitArgs("/r", ["push"], undefined, "remote"));
    expect(remote).not.toContain("protocol.allow=never");
    expect(remote).not.toContain("credential.helper=");
    expect(local).toContain("protocol.allow=never");
    expect(local).toContain("credential.helper=");
    expect(remote.slice(0, -3)).toEqual(
      local.filter((pair) => pair !== "protocol.allow=never" && pair !== "credential.helper="),
    );
    expect(remote.slice(-3)).toEqual([
      "push.recurseSubmodules=no",
      "push.followTags=false",
      "push.pushOption=",
    ]);
    expect(remote).toContain("core.hooksPath=/dev/null");
  });

  it("the local profile is the default and adds no push pair", () => {
    expect(pairs(gitArgs("/r", ["status"]))).not.toContain("push.followTags=false");
  });

  const base: NodeJS.ProcessEnv = {
    PATH: "/bin",
    HOME: "/h",
    SSH_AUTH_SOCK: "/run/agent",
    HTTPS_PROXY: "http://p",
    NODE_EXTRA_CA_CERTS: "/ca.pem",
    GIT_DIR: "/evil",
    GH_TOKEN: "t",
  };

  it("remote env keeps the agent, the proxies and CA bundles, drops GIT_DIR, allows https and ssh", () => {
    const env = gitEnv(base, "/srv/p", "remote");
    expect(env).toMatchObject({
      SSH_AUTH_SOCK: "/run/agent",
      HTTPS_PROXY: "http://p",
      NODE_EXTRA_CA_CERTS: "/ca.pem",
      GIT_ALLOW_PROTOCOL: "https:ssh",
    });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
  });

  it("the test seam replaces the protocols", () => {
    expect(gitEnv(base, "/srv/p", "remote", "file").GIT_ALLOW_PROTOCOL).toBe("file");
  });

  it("local env has no transport and no agent", () => {
    const env = gitEnv(base, "/srv/p");
    expect(env.GIT_ALLOW_PROTOCOL).toBe("");
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
  });

  it("the SSH agent is the only name the remote profile keeps that unattended children never get", () => {
    expect([...KEPT, ...KEPT_REMOTE].filter((name) => isNeverPassedEnvKey(name))).toEqual(["SSH_AUTH_SOCK"]);
  });
});
