import { describe, expect, it } from "vitest";
import { createShellEnvironment, shellEnv } from "./shell-env.ts";

const BASE = {
  ANTHROPIC_API_KEY: "sk-ant-0123456789",
  SSH_AUTH_SOCK: "/run/user/1000/ssh",
  HTTPS_PROXY: "http://proxy:3128",
  PAP_HOME: "/home/u/.pap",
  PAP_WORKER_TOKEN: "0123456789abcdef0123",
  GIT_DIR: "/x/.git",
  NODE_OPTIONS: "--require /tmp/evil.js",
  GH_TOKEN: "ghp_0123456789",
  XDG_CONFIG_HOME: "/home/u/.config",
  PI_CODING_AGENT_DIR: "/home/u/.pi/agent",
  HOME: "/home/u",
  LANG: "C.UTF-8",
  PATH: "bin:/usr/bin:./x:/usr/local/bin:",
};

describe("shellEnv (M11R24)", () => {
  it("lets nothing credential-looking or hijacking through", () => {
    const env = shellEnv(BASE, {});
    expect(env).toEqual({
      LANG: "C.UTF-8",
      PATH: "/usr/bin:/usr/local/bin",
      TERM: "dumb",
      HOME: "/home/u",
    });
  });

  it("never keeps the owner's proxy variables (decision 90)", () => {
    const env = shellEnv({ ...BASE, NO_PROXY: "*", SSL_CERT_FILE: "/x.pem" }, {});
    for (const name of [
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "NODE_USE_ENV_PROXY",
      "SSL_CERT_FILE",
    ])
      expect(env).not.toHaveProperty(name);
  });

  it("adds the vault, and a vault HOME is refused", () => {
    const env = shellEnv(BASE, { VAULT_TOKEN: "vault-0123456789", HOME: "/evil" });
    expect(env.VAULT_TOKEN).toBe("vault-0123456789");
    expect(env.HOME).toBe("/home/u");
  });

  it("falls back to the system PATH when no entry is absolute", () => {
    expect(shellEnv({ PATH: "bin:." }, {}).PATH).toBe("/usr/local/bin:/usr/bin:/bin");
  });
});

describe("createShellEnvironment", () => {
  it("is built from a snapshot of the base taken at start and rebuilt on a vault update", () => {
    const base: Record<string, string> = { LANG: "C.UTF-8", PATH: "/usr/bin" };
    const environment = createShellEnvironment(base, { A_KEY_NAME: "first-value-1" });
    base.ANTHROPIC_API_KEY = "sk-late-0123456789";
    base.LANG = "fr_FR.UTF-8";
    expect(environment.envFor("ls")).toMatchObject({ LANG: "C.UTF-8", A_KEY_NAME: "first-value-1" });
    expect(environment.envFor("ls")).not.toHaveProperty("ANTHROPIC_API_KEY");
    environment.setVault({ B_NAME: "second-value-2" });
    const env = environment.envFor("ls");
    expect(env.LANG).toBe("C.UTF-8");
    expect(env).toMatchObject({ B_NAME: "second-value-2" });
    expect(env).not.toHaveProperty("A_KEY_NAME");
  });

  it("hands out a copy: a caller cannot widen the environment of the next command", () => {
    const environment = createShellEnvironment({}, {});
    const first = environment.envFor("ls") as Record<string, string>;
    first.INJECTED = "x";
    expect(environment.envFor("ls")).not.toHaveProperty("INJECTED");
  });
});

describe("envFor, defence in depth (W5-R17)", () => {
  it("never carries a hijack name, even if a vault held one", () => {
    const environment = createShellEnvironment(
      {},
      {
        LD_PRELOAD: "/x/evil.so",
        HTTPS_PROXY: "http://evil",
        GITHUB_TOKEN: "ghp_0123456789",
      },
    );
    expect(environment.envFor("ls")).toMatchObject({ GITHUB_TOKEN: "ghp_0123456789" });
    expect(environment.envFor("ls")).not.toHaveProperty("LD_PRELOAD");
    expect(environment.envFor("ls")).not.toHaveProperty("HTTPS_PROXY");
    environment.setVault({ LD_AUDIT: "/x/evil.so" });
    expect(environment.envFor("ls")).not.toHaveProperty("LD_AUDIT");
    expect(shellEnv({}, { LD_PRELOAD: "/x" })).not.toHaveProperty("LD_PRELOAD");
  });
});
