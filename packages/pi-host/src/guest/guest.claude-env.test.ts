import { describe, expect, it, vi } from "vitest";
import { layout, spawnCommand, start } from "../testing/guest-harness.ts";

const spawnedEnv = async (env: Record<string, string> | undefined) => {
  const run = await start();
  await run.hello();
  run.gateway.send(spawnCommand(env === undefined ? {} : { env }));
  await vi.waitFor(() => expect(run.children).toHaveLength(1));
  return { env: run.spawnEnvs[0] as NodeJS.ProcessEnv, logs: run.logs };
};

describe("runGuest extra environment of a spawn", () => {
  it("applies IS_SANDBOX=1 and a CLAUDE_CONFIG_DIR under the layout home", async () => {
    const { env } = await spawnedEnv({ IS_SANDBOX: "1", CLAUDE_CONFIG_DIR: `${layout.home}/.claude` });
    expect(env.IS_SANDBOX).toBe("1");
    expect(env.CLAUDE_CONFIG_DIR).toBe(`${layout.home}/.claude`);
  });

  it("sets neither without an extra environment", async () => {
    const { env } = await spawnedEnv(undefined);
    expect("IS_SANDBOX" in env).toBe(false);
    expect("CLAUDE_CONFIG_DIR" in env).toBe(false);
  });

  it("refuses a key outside the allowlist and logs it without the value", async () => {
    const { env, logs } = await spawnedEnv({ LD_PRELOAD: "/evil.so", IS_SANDBOX: "1" });
    expect("LD_PRELOAD" in env).toBe(false);
    expect(env.IS_SANDBOX).toBe("1");
    expect(logs.join("\n")).toContain("LD_PRELOAD");
    expect(logs.join("\n")).not.toContain("/evil.so");
  });

  it.each([
    ["IS_SANDBOX", "0"],
    ["IS_SANDBOX", "true"],
    ["CLAUDE_CONFIG_DIR", "/root/.claude"],
    ["CLAUDE_CONFIG_DIR", `${layout.home}/../root/.claude`],
    ["CLAUDE_CONFIG_DIR", `${layout.home}x/.claude`],
    ["CLAUDE_CONFIG_DIR", ".claude"],
  ])("refuses %s=%s", async (key, value) => {
    const { env, logs } = await spawnedEnv({ [key]: value });
    expect(key in env).toBe(false);
    expect(logs.join("\n")).toContain(key);
  });
});
