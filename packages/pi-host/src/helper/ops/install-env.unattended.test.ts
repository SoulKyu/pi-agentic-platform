import { FALLBACK_PATH } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installEnv, withInstallEnv } from "./install-env.ts";

afterEach(() => vi.unstubAllEnvs());

const SECRETS = {
  SSH_AUTH_SOCK: "/run/ssh",
  ANTHROPIC_API_KEY: "sk-a",
  OPENAI_API_KEY: "sk-o",
  GH_TOKEN: "ghp",
  NPM_TOKEN: "npm",
  AWS_SECRET_ACCESS_KEY: "aws",
  RANDOM_VAR: "x",
};

describe("installEnv, the shared unattended allowlist (owner c7)", () => {
  it("keeps no SSH agent, provider key, forge or registry token, and no unlisted variable", () => {
    const env = installEnv({ PATH: "/usr/bin", ...SECRETS }, "/home/o");
    for (const key of Object.keys(SECRETS)) expect(env, key).not.toHaveProperty(key);
  });

  it("keeps the network and tooling names", () => {
    const kept = {
      HTTPS_PROXY: "http://p:3128",
      SSL_CERT_FILE: "/ca.pem",
      NODE_EXTRA_CA_CERTS: "/extra.pem",
      TMPDIR: "/tmp/x",
      XDG_CONFIG_HOME: "/cfg",
      LANG: "C.UTF-8",
      LC_ALL: "C",
      TZ: "UTC",
    };
    expect(installEnv({ PATH: "/usr/bin", ...kept }, "/home/o")).toMatchObject(kept);
  });

  it("sets HOME, TERM, the quiet constants and the fallback PATH", () => {
    const env = installEnv({ HOME: "/elsewhere" }, "/home/o");
    expect(env).toMatchObject({
      HOME: "/home/o",
      TERM: "dumb",
      PI_TELEMETRY: "0",
      PI_SKIP_VERSION_CHECK: "1",
      DISABLE_TELEMETRY: "1",
      DO_NOT_TRACK: "1",
      npm_config_update_notifier: "false",
      PATH: FALLBACK_PATH,
    });
  });
});

describe("PI_CODING_AGENT_DIR", () => {
  it("is the given agent folder, whatever base holds, and absent when none is given", () => {
    const base = { PATH: "/usr/bin", PI_CODING_AGENT_DIR: "/other" };
    expect(installEnv(base, "/home/o", "/home/o/agent").PI_CODING_AGENT_DIR).toBe("/home/o/agent");
    expect(installEnv(base, "/home/o")).not.toHaveProperty("PI_CODING_AGENT_DIR");
  });
});

describe("withInstallEnv, the shared allowlist", () => {
  it("hides the SSH agent and provider keys inside run and restores process.env, also after a failure", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-a");
    vi.stubEnv("SSH_AUTH_SOCK", "/run/ssh");
    vi.stubEnv("HTTPS_PROXY", "http://p:3128");
    const before = { ...process.env };
    let seen: NodeJS.ProcessEnv = {};
    await withInstallEnv("/home/o", async () => {
      seen = { ...process.env };
    });
    expect(seen).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(seen).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(seen.HTTPS_PROXY).toBe("http://p:3128");
    expect(process.env).toEqual(before);
    await expect(
      withInstallEnv("/home/o", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(process.env).toEqual(before);
  });
});
