import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installCalls } from "./offline-bed.ts";
import { installPlugin, listPlugins, removePlugin, updatePlugins } from "./plugins.ts";
import {
  agentDir,
  bin,
  codeOf,
  confirm,
  ctxFor,
  cwd,
  globalSettings,
  home,
  local,
  log,
  pkg,
  root,
  trust,
} from "./plugins-bed.ts";

describe("the environment of what Pi starts, and offline reads (MC52)", () => {
  function recordingNpm(): string {
    const file = join(bin, "npm");
    writeFileSync(file, `#!/bin/sh\necho "npm $*" >> "${log}"\nenv > "${join(root, "env.txt")}"\nexit 1\n`);
    chmodSync(file, 0o755);
    return join(root, "env.txt");
  }

  it("gives npm and git the stripped environment: no PAP_*, no NODE_OPTIONS, absolute PATH entries only, then restores it", async () => {
    const envFile = recordingNpm();
    vi.stubEnv("PAP_SECRET_X", "must-not-leak");
    vi.stubEnv("NODE_OPTIONS", "--require /evil.js");
    vi.stubEnv("NOTIFY_SOCKET", "/run/notify");
    vi.stubEnv("PATH", `relative/bin${delimiter}${bin}${delimiter}/usr/bin${delimiter}/bin`);
    vi.stubEnv("PI_OFFLINE", "");
    vi.stubEnv("PI_TELEMETRY", "1");
    expect(
      await codeOf(installPlugin({ source: "npm:@example/pi-tools@1.0.0", scope: "user" }, ctxFor(null))),
    ).toBe("failed");
    const seen = Object.fromEntries(
      readFileSync(envFile, "utf8")
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    for (const key of Object.keys(seen)) expect(key).not.toMatch(/^PAP_/);
    for (const key of ["NODE_OPTIONS", "NOTIFY_SOCKET"]) expect(seen).not.toHaveProperty(key);
    expect(seen.PATH).toBe(`${bin}${delimiter}/usr/bin${delimiter}/bin`);
    expect(seen.PI_TELEMETRY).toBe("0");
    expect(seen.GIT_TERMINAL_PROMPT).toBe("0");
    expect(seen.HOME).toBe(home);
    // The helper's own environment is back as it was.
    expect(process.env.PAP_SECRET_X).toBe("must-not-leak");
    expect(process.env.NODE_OPTIONS).toBe("--require /evil.js");
    expect(process.env.PI_TELEMETRY).toBe("1");
    expect(process.env.PATH?.startsWith(`relative/bin${delimiter}`)).toBe(true);
    expect(globalSettings).toThrow();
  });

  it("a read lists a missing npm package as not installed and never runs npm install or git clone", async () => {
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:@example/pi-tools@1.0.0", "git:github.com/example/pi-tools@v1"] }),
    );
    trust();
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:project-only"] }));
    const listed = await listPlugins(ctxFor());
    expect(listed.plugins.map((plugin) => [plugin.source, plugin.scope, plugin.installedPath])).toEqual([
      ["npm:@example/pi-tools@1.0.0", "user", null],
      ["git:github.com/example/pi-tools@v1", "user", null],
      ["npm:project-only", "project", null],
    ]);
    expect(installCalls(log)).toEqual([]);
    expect(process.env.PI_OFFLINE).toBeUndefined();
  });

  it("masks a credential in a source it lists", async () => {
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["https://user:hunter2@example.com/a/b.git"] }),
    );
    const [plugin] = (await listPlugins(ctxFor(null))).plugins;
    expect(plugin?.source).not.toContain("hunter2");
  });

  it("caps the list at 200 and says so", async () => {
    const packages = Array.from({ length: 205 }, (_, i) => `npm:pkg-${i}`);
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages }));
    const listed = await listPlugins(ctxFor(null));
    expect(listed.plugins).toHaveLength(200);
    expect(listed.truncated).toBe(true);
  });
});

describe("plugins.update (M7R117)", () => {
  it("answers what changed: nothing for a local package, and runs no installer", async () => {
    await installPlugin({ source: pkg, scope: "user" }, ctxFor(null));
    expect(await updatePlugins({}, ctxFor(null))).toEqual({ updated: [] });
    expect(await updatePlugins({ source: local("tools"), scope: "user" }, ctxFor(null))).toEqual({
      updated: [],
    });
    expect(installCalls(log)).toEqual([]);
  });

  it("an unknown source is not_found, and a project update takes the confirmation and a trusted project", async () => {
    expect(await codeOf(updatePlugins({ source: "npm:nothing-here" }, ctxFor(null)))).toBe("not_found");
    expect(await codeOf(updatePlugins({ scope: "project", ...confirm }, ctxFor()))).toBe("project_untrusted");
    trust();
    expect(await codeOf(updatePlugins({ scope: "project" }, ctxFor()))).toBe("protected_path");
    expect(await updatePlugins({ scope: "project", ...confirm }, ctxFor())).toEqual({ updated: [] });
  });

  /** A fake `npm` that knows `view` (a newer version exists) and logs every other call, `install` included. */
  function newerNpm(): void {
    const file = join(bin, "npm");
    writeFileSync(
      file,
      `#!/bin/sh\nif [ "$1" = view ]; then echo '"2.0.0"'; exit 0; fi\necho "npm $*" >> "${log}"\nexit 0\n`,
    );
    chmodSync(file, 0o755);
  }
  const installed = (base: string) => {
    const dir = join(base, "npm", "node_modules", "@example", "pi-tools");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@example/pi-tools", version: "1.0.0" }));
  };

  it("applies the update the check found and reports it", async () => {
    newerNpm();
    installed(agentDir);
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:@example/pi-tools"] }));
    expect(await updatePlugins({}, ctxFor(null))).toEqual({
      updated: [{ source: "npm:@example/pi-tools", scope: "user" }],
    });
    expect(installCalls(log)).toEqual([
      `npm install @example/pi-tools@latest --prefix ${join(agentDir, "npm")} --legacy-peer-deps`,
    ]);
  });

  it("a project update never reaches the user's packages, and a user update never reaches the project's", async () => {
    newerNpm();
    trust();
    installed(agentDir);
    installed(join(cwd, ".pi"));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:@example/pi-tools"] }));
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:@example/pi-tools"] }));
    expect(await updatePlugins({ scope: "project", ...confirm }, ctxFor())).toEqual({
      updated: [{ source: "npm:@example/pi-tools", scope: "project" }],
    });
    expect(installCalls(log).join("\n")).toContain(join(cwd, ".pi", "npm"));
    expect(installCalls(log).join("\n")).not.toContain(agentDir);
    writeFileSync(log, "");
    expect(await updatePlugins({ scope: "user" }, ctxFor())).toEqual({
      updated: [{ source: "npm:@example/pi-tools", scope: "user" }],
    });
    expect(installCalls(log).join("\n")).not.toContain(join(cwd, ".pi"));
  });

  it("never hands Pi a hand-written source that fails validation", async () => {
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:--registry=http://evil/", "git:-oProxyCommand=x/y"] }),
    );
    expect(await updatePlugins({}, ctxFor(null))).toEqual({ updated: [] });
    expect(
      await codeOf(removePlugin({ source: "npm:--registry=http://evil/", scope: "user" }, ctxFor(null))),
    ).toBe("resolved");
    expect(installCalls(log)).toEqual([]);
    expect(globalSettings().packages).toEqual(["git:-oProxyCommand=x/y"]);
  });
});
