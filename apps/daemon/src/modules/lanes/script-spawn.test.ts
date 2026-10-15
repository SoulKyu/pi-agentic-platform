import { describe, expect, it } from "vitest";
import { scriptEnv, scriptSpec } from "./script-spawn.ts";

const lane = { id: "lane-0001", root: "/srv/project", worktree: "/srv/wt/lane-0001" };

describe("scriptEnv (M9R28, owner c7)", () => {
  it("keeps exactly the allowlist and the three lane variables against a hostile base", () => {
    const base = {
      HOME: "/home/o",
      PATH: "/usr/bin:/bin:.:node_modules/.bin",
      PAP_SECRET: "s",
      NODE_OPTIONS: "--require /x",
      GIT_DIR: "/x",
      GIT_INDEX_FILE: "/x",
      NOTIFY_SOCKET: "/x",
      SSH_AUTH_SOCK: "/agent",
      ANTHROPIC_API_KEY: "k",
      GH_TOKEN: "t",
      OK_VAR: "v",
      HTTPS_PROXY: "http://p",
      TMPDIR: "/tmp/x",
      XDG_CACHE_HOME: "/c",
    };
    expect(scriptEnv(base, lane)).toEqual({
      HOME: "/home/o",
      HTTPS_PROXY: "http://p",
      TMPDIR: "/tmp/x",
      XDG_CACHE_HOME: "/c",
      PATH: "/usr/bin:/bin",
      TERM: "dumb",
      PAP_LANE_ID: "lane-0001",
      PAP_LANE_ROOT: "/srv/project",
      PAP_LANE_WORKTREE: "/srv/wt/lane-0001",
    });
  });

  it("does not let the base override the lane variables", () => {
    const env = scriptEnv({ HOME: "/h", PAP_LANE_ID: "evil" }, lane);
    expect(env.PAP_LANE_ID).toBe("lane-0001");
  });
});

describe("scriptSpec (M9R27)", () => {
  const base = { kind: "setup", script: "pnpm install", umask: 0o022, env: { A: "1" } } as const;

  it("without a scope: sh -c umask wrapper, then bash -e -c <text>, $0 the script name", () => {
    const spec = scriptSpec({ ...base, scope: null });
    expect(spec.file).toBe("/bin/sh");
    expect(spec.args).toEqual([
      "-c",
      'umask "$1" && shift && exec "$@"',
      "pap-lane-setup",
      "0022",
      "bash",
      "-e",
      "-c",
      "pnpm install",
      "pap-lane-setup",
    ]);
    expect(spec.env).toEqual({ A: "1" });
  });

  it("with a scope: the scope's command and args first, its environment added", () => {
    const scope = {
      command: "systemd-run",
      args: ["--user", "--scope", "--"],
      env: { XDG_RUNTIME_DIR: "/run/u" },
    };
    const spec = scriptSpec({ ...base, kind: "test", umask: 0o077, scope });
    expect(spec.file).toBe("systemd-run");
    expect(spec.args.slice(0, 3)).toEqual(["--user", "--scope", "--"]);
    expect(spec.args.slice(3, 8)).toEqual([
      "/bin/sh",
      "-c",
      'umask "$1" && shift && exec "$@"',
      "pap-lane-test",
      "0077",
    ]);
    expect(spec.env).toEqual({ A: "1", XDG_RUNTIME_DIR: "/run/u" });
  });

  it("keeps a script with quotes, $(...) and newlines as one element", () => {
    const script = `echo "a'b" $(id)\nrm -rf '$HOME'; \`x\`\n`;
    const spec = scriptSpec({ ...base, script, scope: null });
    expect(spec.args).toHaveLength(9);
    expect(spec.args[7]).toBe(script);
  });
});
