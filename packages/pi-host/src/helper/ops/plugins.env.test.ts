import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installPlugin } from "./plugins.ts";
import { bin, codeOf, ctxFor, log, root } from "./plugins-bed.ts";

describe("what Pi starts for a plugin install sees the shared unattended environment (owner c7)", () => {
  it("gives npm no provider key, SSH agent or registry token, and keeps the proxy", async () => {
    const envFile = join(root, "env.txt");
    const file = join(bin, "npm");
    writeFileSync(file, `#!/bin/sh\necho "npm $*" >> "${log}"\nenv > "${envFile}"\nexit 1\n`);
    chmodSync(file, 0o755);
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-a");
    vi.stubEnv("OPENAI_API_KEY", "sk-o");
    vi.stubEnv("SSH_AUTH_SOCK", "/run/ssh");
    vi.stubEnv("NPM_TOKEN", "npm");
    vi.stubEnv("HTTPS_PROXY", "http://p:3128");
    vi.stubEnv("PI_OFFLINE", "");
    expect(
      await codeOf(installPlugin({ source: "npm:@example/pi-tools@1.0.0", scope: "user" }, ctxFor(null))),
    ).toBe("failed");
    const names = readFileSync(envFile, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => line.slice(0, line.indexOf("=")));
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SSH_AUTH_SOCK", "NPM_TOKEN"])
      expect(names, key).not.toContain(key);
    expect(names).toContain("HTTPS_PROXY");
  });
});
