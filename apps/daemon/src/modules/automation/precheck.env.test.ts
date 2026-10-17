import { describe, expect, it } from "vitest";
import { precheckEnv } from "./precheck.ts";

const DAEMON_ENV = {
  HOME: "/home/owner",
  USER: "owner",
  LANG: "C.UTF-8",
  PATH: "/usr/bin:./node_modules/.bin:/bin:relative/bin",
  PAP_METRICS_TOKEN: "metrics-secret",
  ANTHROPIC_API_KEY: "sk-ant-secret",
  NODE_OPTIONS: "--require /tmp/evil.js",
  SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
  GH_TOKEN: "ghp_secret",
  HTTPS_PROXY: "http://proxy:3128",
  KUBECONFIG: "/home/owner/.kube/config",
};

describe("precheckEnv (owner c7, m10q7)", () => {
  it("keeps the base allowlist, the proxies and the trigger's names, with an absolute-only PATH", () => {
    const env = precheckEnv(DAEMON_ENV, ["KUBECONFIG"]);
    expect(env).toEqual({
      HOME: "/home/owner",
      USER: "owner",
      LANG: "C.UTF-8",
      PATH: "/usr/bin:/bin",
      TERM: "dumb",
      HTTPS_PROXY: "http://proxy:3128",
      KUBECONFIG: "/home/owner/.kube/config",
    });
  });

  it("withholds the daemon's own, the provider and forge keys and the SSH agent, even when a stored trigger names them", () => {
    const env = precheckEnv(DAEMON_ENV, ["SSH_AUTH_SOCK", "GH_TOKEN", "ANTHROPIC_API_KEY", "NODE_OPTIONS"]);
    for (const name of [
      "PAP_METRICS_TOKEN",
      "ANTHROPIC_API_KEY",
      "NODE_OPTIONS",
      "SSH_AUTH_SOCK",
      "GH_TOKEN",
    ])
      expect(env).not.toHaveProperty(name);
  });

  it("does not carry a variable the trigger did not name", () => {
    expect(precheckEnv(DAEMON_ENV, [])).not.toHaveProperty("KUBECONFIG");
  });

  it("an agent's precheck never keeps the owner's proxy variables; with network it gets pap's proxy (decision 90)", () => {
    const off = precheckEnv(DAEMON_ENV, ["KUBECONFIG"], { proxied: false });
    expect(off).not.toHaveProperty("HTTPS_PROXY");
    expect(off).not.toHaveProperty("NO_PROXY");
    const on = precheckEnv({ ...DAEMON_ENV, NO_PROXY: "*", ALL_PROXY: "socks5h://upstream:1080" }, [], {
      proxied: true,
    });
    expect(on).toMatchObject({
      HTTP_PROXY: "http://127.0.0.1:3128",
      HTTPS_PROXY: "http://127.0.0.1:3128",
      ALL_PROXY: "http://127.0.0.1:3128",
      https_proxy: "http://127.0.0.1:3128",
      NO_PROXY: "",
      no_proxy: "",
    });
    expect(JSON.stringify(on)).not.toContain("upstream");
    expect(JSON.stringify(on)).not.toContain("proxy:3128");
  });
});
