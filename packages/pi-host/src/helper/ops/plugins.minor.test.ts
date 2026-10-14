import { linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { maskSource } from "../plugin-entries.ts";
import { installPlugin, removePlugin, setPluginsEnabled, updatePlugins } from "./plugins.ts";
import {
  agentDir,
  codeOf,
  confirm,
  ctxFor,
  cwd,
  home,
  local,
  pkg,
  projectSettings,
  root,
  trust,
} from "./plugins-bed.ts";

describe("the project settings.json has the write-time guard of the agent's (MC55, T25 M4)", () => {
  const twinOfProjectSettings = (): string => {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    const file = join(cwd, ".pi", "settings.json");
    writeFileSync(file, JSON.stringify({ packages: [local("tools")] }));
    linkSync(file, join(root, "twin-settings.json"));
    return file;
  };

  it("refuses every project write while the file has another hard link, and leaves it as it was", async () => {
    trust();
    const file = twinOfProjectSettings();
    const before = readFileSync(file, "utf8");
    const item = { source: local("tools"), scope: "project" as const };
    expect(await codeOf(installPlugin({ source: pkg, scope: "project", ...confirm }, ctxFor()))).toBe(
      "config_path_refused",
    );
    expect(await codeOf(setPluginsEnabled({ items: [item], enabled: false, ...confirm }, ctxFor()))).toBe(
      "config_path_refused",
    );
    expect(await codeOf(removePlugin({ ...item, ...confirm }, ctxFor()))).toBe("config_path_refused");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readFileSync(join(root, "twin-settings.json"), "utf8")).toBe(before);
  });

  it("still writes a project file that has a single link", async () => {
    trust();
    await installPlugin({ source: pkg, scope: "project", ...confirm }, ctxFor());
    expect(projectSettings().packages).toHaveLength(1);
  });
});

describe("a local source is checked on its real path (MC55, T25 M8)", () => {
  it("refuses a link inside home that leads out of it, and the home folder itself", async () => {
    const outside = join(root, "outside-pkg");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "package.json"), JSON.stringify({ name: "outside", version: "1.0.0" }));
    symlinkSync(outside, join(home, "pkgs", "link"));
    for (const source of [join(home, "pkgs", "link"), home])
      expect(await codeOf(installPlugin({ source, scope: "user" }, ctxFor(null))), source).toBe("bad_params");
    expect(() => readFileSync(join(agentDir, "settings.json"))).toThrow();
  });

  it("still accepts a link that stays inside home", async () => {
    symlinkSync(pkg, join(home, "pkgs", "alias"));
    expect(await installPlugin({ source: join(home, "pkgs", "alias"), scope: "user" }, ctxFor(null))).toEqual(
      {
        ok: true,
      },
    );
  });
});

describe("two entries that mask to the same text are never acted on by the first one alone (MC55, T25 M9)", () => {
  const first = "https://u:aaa@host.tld/x";
  const second = "https://u:bbb@host.tld/x";
  const masked = maskSource(first);

  it("masks both to one text, and remove, setEnabled and update refuse with conflict and write nothing", async () => {
    expect(maskSource(second)).toBe(masked);
    const file = join(agentDir, "settings.json");
    writeFileSync(file, JSON.stringify({ packages: [first, second] }));
    const before = readFileSync(file, "utf8");
    expect(await codeOf(removePlugin({ source: masked, scope: "user" }, ctxFor(null)))).toBe("conflict");
    expect(
      await codeOf(
        setPluginsEnabled({ items: [{ source: masked, scope: "user" }], enabled: false }, ctxFor(null)),
      ),
    ).toBe("conflict");
    expect(await codeOf(updatePlugins({ source: masked, scope: "user" }, ctxFor(null)))).toBe("conflict");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("a text that names one entry still finds it", async () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [first, "npm:other"] }));
    expect(await codeOf(removePlugin({ source: "npm:other", scope: "user" }, ctxFor(null)))).toBe("resolved");
  });
});
