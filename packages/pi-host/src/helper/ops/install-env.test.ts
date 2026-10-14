import { PLATFORM_ENV_KEYS } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installEnv, withInstallEnv } from "./install-env.ts";

afterEach(() => vi.unstubAllEnvs());

describe("installEnv", () => {
  it("drops every key of the shared daemon-only list: PAP_*, NODE_OPTIONS and each service-manager key", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin", PAP_ANY: "x", NODE_OPTIONS: "--y" };
    for (const key of PLATFORM_ENV_KEYS) base[key] = "x";
    const env = installEnv(base, "/home/o");
    for (const key of [...PLATFORM_ENV_KEYS, "PAP_ANY", "NODE_OPTIONS"])
      expect(env, key).not.toHaveProperty(key);
    // A drift in the list would show here: the daemon's own list (supervisor/env.test.ts) pins the same 15 keys.
    expect(PLATFORM_ENV_KEYS).toHaveLength(15);
  });
});

describe("withInstallEnv", () => {
  it("runs with the stripped environment in process.env and puts the original back, also after a failure", async () => {
    vi.stubEnv("PAP_X", "secret");
    vi.stubEnv("NODE_OPTIONS", "--require /e.js");
    vi.stubEnv("PATH", `rel/bin:/usr/bin`);
    const before = { ...process.env };
    let seen: NodeJS.ProcessEnv = {};
    await withInstallEnv("/home/o", async () => {
      seen = { ...process.env };
    });
    expect(seen).not.toHaveProperty("PAP_X");
    expect(seen).not.toHaveProperty("NODE_OPTIONS");
    expect(seen.PATH).toBe("/usr/bin");
    expect(seen.GIT_TERMINAL_PROMPT).toBe("0");
    expect(seen.HOME).toBe("/home/o");
    expect(process.env).toEqual(before);
    await expect(
      withInstallEnv("/home/o", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(process.env).toEqual(before);
  });
});

describe("PLATFORM_ENV_KEYS (MC55, T25 M13)", () => {
  it("is frozen, so no caller can widen or empty the daemon-only list", () => {
    expect(Object.isFrozen(PLATFORM_ENV_KEYS)).toBe(true);
    expect(() => (PLATFORM_ENV_KEYS as string[]).push("X")).toThrow(TypeError);
  });
});
