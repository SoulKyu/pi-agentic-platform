import { execFile as nodeExecFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runInstall, SKILLS_CLI_BEFORE } from "./skills-install.ts";

describe("skills.install environment (owner c7)", () => {
  it("hands npx the shared unattended environment: no SSH agent, provider key or registry token, npm_config_before kept", async () => {
    let seen: NodeJS.ProcessEnv | undefined;
    const execFile = ((
      _file: string,
      _args: string[],
      options: { env?: NodeJS.ProcessEnv },
      done: (error: null, out: string, err: string) => void,
    ) => {
      seen = options.env;
      done(null, "", "");
    }) as unknown as typeof nodeExecFile;
    await runInstall(
      { source: "o/r", scope: "global" },
      { agentDir: "/h/.pi/agent", home: "/h", signal: new AbortController().signal },
      {
        execFile,
        env: {
          PATH: "/usr/bin",
          HOME: "/elsewhere",
          SSH_AUTH_SOCK: "/run/ssh",
          PI_CODING_AGENT_DIR: "/other",
          ANTHROPIC_API_KEY: "sk-a",
          NPM_TOKEN: "npm",
          HTTPS_PROXY: "http://p:3128",
        },
      },
    );
    expect(seen).toBeDefined();
    expect(seen).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(seen).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(seen).not.toHaveProperty("NPM_TOKEN");
    expect(seen).toMatchObject({
      HTTPS_PROXY: "http://p:3128",
      HOME: "/h",
      PI_CODING_AGENT_DIR: "/h/.pi/agent",
      npm_config_before: SKILLS_CLI_BEFORE,
    });
  });
});
