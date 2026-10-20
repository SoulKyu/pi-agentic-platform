import { linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PluginsListResult } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { installCalls } from "./offline-bed.ts";
import { installPlugin, listPlugins, removePlugin, setPluginsEnabled } from "./plugins.ts";
import {
  codeOf,
  confirm,
  ctxFor,
  globalSettings,
  home,
  local,
  log,
  off,
  pkg,
  projectSettings,
  root,
  settingsOf,
  trust,
  cwd,
  agentDir,
} from "./plugins-bed.ts";

const ID = expect.stringMatching(/^[0-9a-f]{32}$/);

describe("plugins.install / list / setEnabled / remove, local package, user scope (M7R114)", () => {
  it("installs a local folder into settings.json, lists it enabled, switches it off and on, removes it", async () => {
    expect(await installPlugin({ source: pkg, scope: "user" }, ctxFor(null))).toEqual({ ok: true });
    expect(globalSettings().packages).toEqual([local("tools")]);

    const listed = await listPlugins(ctxFor(null));
    expect(PluginsListResult.safeParse(listed).success).toBe(true);
    expect(listed).toEqual({
      plugins: [
        { id: ID, source: local("tools"), scope: "user", installedPath: pkg, enabled: true, filtered: false },
      ],
      truncated: false,
    });

    const item = { source: local("tools"), scope: "user" as const };
    expect(await setPluginsEnabled({ items: [item], enabled: false }, ctxFor(null))).toEqual({
      results: [{ ...item, ok: true }],
    });
    expect(globalSettings().packages).toEqual([{ source: local("tools"), ...off }]);
    expect((await listPlugins(ctxFor(null))).plugins[0]).toMatchObject({ enabled: false, filtered: false });

    await setPluginsEnabled({ items: [item], enabled: true }, ctxFor(null));
    expect(globalSettings().packages).toEqual([local("tools")]);
    expect((await listPlugins(ctxFor(null))).plugins[0]).toMatchObject({ enabled: true });

    expect(await removePlugin({ source: local("tools"), scope: "user" }, ctxFor(null))).toEqual({ ok: true });
    expect(globalSettings().packages).toEqual([]);
    expect((await listPlugins(ctxFor(null))).plugins).toEqual([]);
    // Nothing ran npm or git, and (the afterEach) the network guard saw no request.
    expect(installCalls(log)).toEqual([]);
  });

  it("finds a package by the absolute path it was installed from", async () => {
    await installPlugin({ source: pkg, scope: "user" }, ctxFor(null));
    expect(await removePlugin({ source: pkg, scope: "user" }, ctxFor(null))).toEqual({ ok: true });
    expect(globalSettings().packages).toEqual([]);
  });

  it("installing the same source twice keeps one entry", async () => {
    await installPlugin({ source: pkg, scope: "user" }, ctxFor(null));
    await installPlugin({ source: pkg, scope: "user" }, ctxFor(null));
    expect(globalSettings().packages).toEqual([local("tools")]);
  });

  it("reports a hand-written filter as filtered and refuses to switch it, leaving the file as it was", async () => {
    const entry = { source: local("tools"), skills: ["skills/hello"] };
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [entry] }));
    const before = readFileSync(join(agentDir, "settings.json"), "utf8");
    expect((await listPlugins(ctxFor(null))).plugins[0]).toMatchObject({ enabled: true, filtered: true });
    const item = { source: local("tools"), scope: "user" as const };
    expect(await setPluginsEnabled({ items: [item], enabled: false }, ctxFor(null))).toEqual({
      results: [{ ...item, ok: false, code: "filtered" }],
    });
    expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(before);
  });

  it("answers a row per item: an unknown package is not_found and the others are switched", async () => {
    await installPlugin({ source: pkg, scope: "user" }, ctxFor(null));
    const known = { source: local("tools"), scope: "user" as const };
    const unknown = { source: "npm:nothing-here", scope: "user" as const };
    const { results } = await setPluginsEnabled({ items: [unknown, known], enabled: false }, ctxFor(null));
    expect(results).toEqual([
      { ...unknown, ok: false, code: "not_found" },
      { ...known, ok: true },
    ]);
  });

  it("removing a package that is not configured is not_found", async () => {
    expect(await codeOf(removePlugin({ source: "npm:nothing-here", scope: "user" }, ctxFor(null)))).toBe(
      "not_found",
    );
  });

  it("refuses a source Pi must not see, before anything runs", async () => {
    for (const source of ["--registry=x", "./tools", "/etc/x", "https://u:p@h/x", "npm:-x", `${home}/../etc`])
      expect(await codeOf(installPlugin({ source, scope: "user" }, ctxFor(null))), source).toBe("bad_params");
    expect(installCalls(log)).toEqual([]);
  });

  it("refuses the git source that Pi would read as a path outside home, and leaves settings.json as it was (MC54)", async () => {
    const file = join(agentDir, "settings.json");
    writeFileSync(file, JSON.stringify({ packages: [] }));
    const before = readFileSync(file, "utf8");
    for (const source of ["git:a/../../../../outside/evil", "git:host.tld/a/b@--upload-pack"])
      expect(await codeOf(installPlugin({ source, scope: "user" }, ctxFor(null))), source).toBe("bad_params");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(installCalls(log)).toEqual([]);
  });

  it("a local folder that is not there is not_found", async () => {
    expect(
      await codeOf(installPlugin({ source: join(home, "pkgs", "gone"), scope: "user" }, ctxFor(null))),
    ).toBe("not_found");
  });

  it("a user-scope call ignores the project folder it was given", async () => {
    trust();
    await installPlugin({ source: pkg, scope: "user" }, ctxFor());
    expect(globalSettings().packages).toEqual([local("tools")]);
    expect(() => readFileSync(join(cwd, ".pi", "settings.json"))).toThrow();
  });
});

describe("Pi's settings file is written only where Pi's own rules allow", () => {
  it("refuses a settings.json with another hard link, and one that links outside the agent directory and home", async () => {
    const file = join(agentDir, "settings.json");
    writeFileSync(file, JSON.stringify({ packages: [local("tools")] }));
    linkSync(file, join(root, "other-link.json"));
    const item = { source: local("tools"), scope: "user" as const };
    expect(await codeOf(setPluginsEnabled({ items: [item], enabled: false }, ctxFor(null)))).toBe(
      "config_path_refused",
    );
    expect(await codeOf(installPlugin({ source: pkg, scope: "user" }, ctxFor(null)))).toBe(
      "config_path_refused",
    );
    expect(await codeOf(removePlugin(item, ctxFor(null)))).toBe("config_path_refused");
    expect(settingsOf(file).packages).toEqual([local("tools")]);

    rmSync(file);
    const outside = join(root, "outside.json");
    writeFileSync(outside, JSON.stringify({ packages: [] }));
    symlinkSync(outside, file);
    expect(await codeOf(installPlugin({ source: pkg, scope: "user" }, ctxFor(null)))).toBe(
      "config_path_refused",
    );
    expect(settingsOf(outside).packages).toEqual([]);
  });

  it("does not write over a settings.json it could not parse", async () => {
    writeFileSync(join(agentDir, "settings.json"), "{ not json");
    expect(await codeOf(installPlugin({ source: pkg, scope: "user" }, ctxFor(null)))).toBe("config_invalid");
    expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe("{ not json");
  });
});

describe("project scope (M7R116, M7R140)", () => {
  it("is refused in an untrusted project, and without the confirmation, and a missing folder is bad_params", async () => {
    expect(await codeOf(installPlugin({ source: pkg, scope: "project", ...confirm }, ctxFor()))).toBe(
      "project_untrusted",
    );
    trust();
    expect(await codeOf(installPlugin({ source: pkg, scope: "project" }, ctxFor()))).toBe("protected_path");
    expect(await codeOf(installPlugin({ source: pkg, scope: "project", ...confirm }, ctxFor(null)))).toBe(
      "bad_params",
    );
    expect(() => readFileSync(join(cwd, ".pi", "settings.json"))).toThrow();
  });

  it("installs into the project's .pi/settings.json, lists it with its scope, and a user list does not show it", async () => {
    trust();
    expect(await installPlugin({ source: pkg, scope: "project", ...confirm }, ctxFor())).toEqual({
      ok: true,
    });
    expect(projectSettings().packages).toEqual([join("..", "..", "..", "pkgs", "tools")]);
    expect(globalSettings).toThrow();
    const listed = await listPlugins(ctxFor());
    expect(listed.plugins).toEqual([
      {
        id: ID,
        source: join("..", "..", "..", "pkgs", "tools"),
        scope: "project",
        installedPath: pkg,
        enabled: true,
        filtered: false,
      },
    ]);
    expect((await listPlugins(ctxFor(null))).plugins).toEqual([]);
  });

  it("does not list an untrusted project's packages", async () => {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:evil-pkg"] }));
    expect((await listPlugins(ctxFor())).plugins).toEqual([]);
  });

  it("switches and removes a project package only with the confirmation", async () => {
    trust();
    await installPlugin({ source: pkg, scope: "project", ...confirm }, ctxFor());
    const item = { source: join("..", "..", "..", "pkgs", "tools"), scope: "project" as const };
    expect(await codeOf(setPluginsEnabled({ items: [item], enabled: false }, ctxFor()))).toBe(
      "protected_path",
    );
    expect(await codeOf(removePlugin({ ...item }, ctxFor()))).toBe("protected_path");
    await setPluginsEnabled({ items: [item], enabled: false, ...confirm }, ctxFor());
    expect(projectSettings().packages).toEqual([{ source: item.source, ...off }]);
    await removePlugin({ ...item, ...confirm }, ctxFor());
    expect(projectSettings().packages).toEqual([]);
  });
});
