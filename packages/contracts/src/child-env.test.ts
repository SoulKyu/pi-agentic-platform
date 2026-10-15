import { describe, expect, it } from "vitest";
import { FALLBACK_PATH, isNeverPassedEnvKey, NETWORK_ENV, TOOLING_ENV, unattendedEnv } from "./child-env.ts";
import { PLATFORM_ENV_KEYS } from "./env-keys.ts";

const dropped = [
  "PAP_SECRET",
  "NODE_OPTIONS",
  ...PLATFORM_ENV_KEYS,
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GPG_AGENT_INFO",
  "BASH_ENV",
  "ENV",
  "PROMPT_COMMAND",
  "GIT_DIR",
  "GIT_CONFIG_GLOBAL",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITLAB_TOKEN",
  "NPM_TOKEN",
  "DB_PASSWORD",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "HF_TOKEN",
  "MY_SECRET",
  "RANDOM_VAR",
];
const hostile: Record<string, string> = {
  HOME: "/home/me",
  USER: "me",
  LOGNAME: "me",
  LANG: "C.UTF-8",
  LC_ALL: "C",
  LC_CTYPE: "C",
  TZ: "UTC",
  PATH: "/usr/bin:relative/bin:./x:/bin:",
  TERM: "xterm",
  HTTPS_PROXY: "http://p",
  NO_PROXY: "x",
  SSL_CERT_FILE: "/c.pem",
  NODE_EXTRA_CA_CERTS: "/n.pem",
  TMPDIR: "/tmp/x",
  XDG_CONFIG_HOME: "/cfg",
  DEPLOY_TARGET: "prod",
  GH_CONFIG_DIR: "/gh",
  ...Object.fromEntries(dropped.map((name) => [name, "v"])),
};

describe("unattendedEnv", () => {
  it("passes only the base keys, absolute PATH entries and TERM=dumb by default", () => {
    expect(unattendedEnv(hostile)).toEqual({
      HOME: "/home/me",
      USER: "me",
      LOGNAME: "me",
      LANG: "C.UTF-8",
      LC_ALL: "C",
      LC_CTYPE: "C",
      TZ: "UTC",
      PATH: "/usr/bin:/bin",
      TERM: "dumb",
    });
  });
  it("keeps the network and tooling families when asked, sets pap's constants, drops every secret", () => {
    const env = unattendedEnv(hostile, {
      keep: [...NETWORK_ENV, ...TOOLING_ENV],
      set: { PAP_LANE_ID: "l-1234" },
    });
    expect(env).toMatchObject({
      HTTPS_PROXY: "http://p",
      NO_PROXY: "x",
      SSL_CERT_FILE: "/c.pem",
      NODE_EXTRA_CA_CERTS: "/n.pem",
      TMPDIR: "/tmp/x",
      XDG_CONFIG_HOME: "/cfg",
      PAP_LANE_ID: "l-1234",
    });
    for (const name of dropped) expect(env, name).not.toHaveProperty(name);
    expect(env).not.toHaveProperty("DEPLOY_TARGET");
  });
  it("never passes a never-passed name even when keep names it", () => {
    const env = unattendedEnv(hostile, {
      keep: [
        "SSH_AUTH_SOCK",
        "GH_TOKEN",
        "ANTHROPIC_API_KEY",
        "GIT_*",
        "LD_*",
        "PAP_*",
        "DEPLOY_TARGET",
        "GH_CONFIG_DIR",
      ],
    });
    expect(Object.keys(env).sort()).toEqual(
      [...Object.keys(unattendedEnv(hostile)), "DEPLOY_TARGET", "GH_CONFIG_DIR"].sort(),
    );
    for (const name of dropped) expect(env, name).not.toHaveProperty(name);
  });
  it("drops every never-passed name even when keep names all of them", () => {
    const never = dropped.filter((name) => name !== "RANDOM_VAR");
    expect(unattendedEnv(hostile, { keep: never })).toEqual(unattendedEnv(hostile));
  });
  it("ignores keep entries that are too short or malformed", () => {
    const base = { A1: "1", AB: "2", "X-Y": "3", "B=1": "4", B: "5" };
    const env = unattendedEnv(base, { keep: ["A*", "*", "X-Y", "B=1"] });
    expect(Object.keys(env).sort()).toEqual(["PATH", "TERM"]);
  });
  it("pins the literal fallback PATH", () => {
    expect(FALLBACK_PATH).toBe("/usr/local/bin:/usr/bin:/bin");
  });
  it("falls back when PATH is missing or all relative; set wins over TERM", () => {
    expect(unattendedEnv({}).PATH).toBe(FALLBACK_PATH);
    expect(unattendedEnv({ PATH: "a:b/c:." }).PATH).toBe(FALLBACK_PATH);
    expect(unattendedEnv({}, { set: { TERM: "xterm" } }).TERM).toBe("xterm");
  });
  it("leaves the prototype alone for a __proto__ key", () => {
    const base = JSON.parse('{"__proto__":{"polluted":"1"},"HOME":"/h"}') as Record<string, string>;
    const env = unattendedEnv(base, { keep: ["__proto__"] });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(env)).toBe(Object.prototype);
    expect(env.polluted).toBeUndefined();
  });
});

describe("isNeverPassedEnvKey", () => {
  it("is true for the agent, daemon, git, loader and credential-like names", () => {
    for (const name of [
      "SSH_AUTH_SOCK",
      "PAP_X",
      "NODE_OPTIONS",
      "GIT_ASKPASS",
      "LD_LIBRARY_PATH",
      "ANTHROPIC_AUTH_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
      "x_api_key",
      "MY_ACCESS_KEY_ID",
      "SLACK_BOT_TOKEN",
      "PGPASSWORD",
      "MYSQL_PWD",
      "REGISTRY_AUTH",
    ])
      expect(isNeverPassedEnvKey(name), name).toBe(true);
  });
  it("is false for ordinary names", () => {
    for (const name of [
      "HOME",
      "LANG",
      "HTTPS_PROXY",
      "XDG_CONFIG_HOME",
      "TMPDIR",
      "DEPLOY_TARGET",
      "GH_HOST",
      "AUTHOR",
      "PWD",
      "PASSTHROUGH",
    ])
      expect(isNeverPassedEnvKey(name), name).toBe(false);
  });
});
