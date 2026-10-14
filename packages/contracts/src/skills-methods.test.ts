import { describe, expect, it } from "vitest";
import { HELPER_OPS, methods, PLUGIN_LIMITS, PluginRowCode, SKILL_LIMITS, SkillView } from "./index.ts";

const view = {
  name: "alpha",
  description: "Does alpha",
  path: "/h/.agents/skills/alpha/SKILL.md",
  scope: "user",
  disableModelInvocation: false,
};

describe("skills methods", () => {
  it("declares the permissions: the masked or path view skills.list is pi:admin (MC55), search is pi:admin (MC59), writes pi:admin and not idempotent", () => {
    expect(methods["skills.list"]).toMatchObject({ permission: "pi:admin", idempotent: true });
    expect(methods["skills.search"]).toMatchObject({ permission: "pi:admin", idempotent: true });
    expect(methods["skills.setInvocation"]).toMatchObject({ permission: "pi:admin", idempotent: false });
    expect(methods["skills.install"]).toMatchObject({ permission: "pi:admin", idempotent: false });
  });

  it("bounds a skill view and a list at 500, and a result list at 20", () => {
    expect(SkillView.safeParse(view).success).toBe(true);
    expect(SkillView.safeParse({ ...view, scope: "elsewhere" }).success).toBe(false);
    expect(SkillView.safeParse({ ...view, extra: 1 }).success).toBe(false);
    const list = methods["skills.list"].result;
    const many = (n: number) => Array.from({ length: n }, () => view);
    expect(list.safeParse({ skills: many(SKILL_LIMITS.list), truncated: false }).success).toBe(true);
    expect(list.safeParse({ skills: many(SKILL_LIMITS.list + 1), truncated: true }).success).toBe(false);
    const hit = { name: "n", source: "o/r", installs: null, url: null };
    const search = methods["skills.search"].result;
    expect(search.safeParse({ results: Array.from({ length: 20 }, () => hit) }).success).toBe(true);
    expect(search.safeParse({ results: Array.from({ length: 21 }, () => hit) }).success).toBe(false);
  });

  it("takes at most 100 switch items, an absolute path each, and only `true` as the confirmation", () => {
    const params = methods["skills.setInvocation"].params;
    const item = { path: "/a/SKILL.md", disabled: true };
    expect(params.safeParse({ items: [item] }).success).toBe(true);
    expect(params.safeParse({ items: [item], cwd: "/w", confirmProtected: true }).success).toBe(true);
    expect(params.safeParse({ items: [item], confirmProtected: false }).success).toBe(false);
    expect(params.safeParse({ items: [{ path: "a/SKILL.md", disabled: true }] }).success).toBe(false);
    expect(params.safeParse({ items: [] }).success).toBe(false);
    expect(params.safeParse({ items: Array.from({ length: 100 }, () => item) }).success).toBe(true);
    expect(params.safeParse({ items: Array.from({ length: 101 }, () => item) }).success).toBe(false);
  });

  it("takes an install source and a scope, nothing else", () => {
    const params = methods["skills.install"].params;
    expect(params.safeParse({ source: "o/r", scope: "global" }).success).toBe(true);
    expect(
      params.safeParse({ source: "o/r", scope: "project", cwd: "/w", confirmProtected: true }).success,
    ).toBe(true);
    expect(params.safeParse({ source: "o/r", scope: "everywhere" }).success).toBe(false);
    expect(params.safeParse({ source: "", scope: "global" }).success).toBe(false);
    expect(params.safeParse({ source: "o/r", scope: "global", flags: "-x" }).success).toBe(false);
  });

  it("lists the codes skills.list answers and bounds every source at one length (MC55)", () => {
    for (const code of ["bad_request", "config_path_refused"])
      expect(methods["skills.list"].errors, code).toContain(code);
    expect(methods["skills.setInvocation"].errors).toContain("config_path_refused");
    expect(SKILL_LIMITS.source).toBe(300);
    const install = methods["skills.install"].params;
    expect(install.safeParse({ source: "x".repeat(300), scope: "global" }).success).toBe(true);
    expect(install.safeParse({ source: "x".repeat(301), scope: "global" }).success).toBe(false);
    const hit = (source: string) => ({ results: [{ name: "n", source, installs: null, url: null }] });
    const search = methods["skills.search"].result;
    expect(search.safeParse(hit("x".repeat(300))).success).toBe(true);
    expect(search.safeParse(hit("x".repeat(301))).success).toBe(false);
  });

  it("has the four helper operations", () => {
    for (const op of ["skills.list", "skills.setInvocation", "skills.search", "skills.install"])
      expect(HELPER_OPS).toHaveProperty([op]);
  });
});

describe("plugins methods (Task 25)", () => {
  const view = {
    source: "npm:@example/pi-tools@1.0.0",
    scope: "user",
    installedPath: "/h/.pi/agent/npm/node_modules/@example/pi-tools",
    enabled: true,
    filtered: false,
  };

  it("reads and writes with pi:admin (MC55: the list serves masked sources and can start npm), writes not idempotent", () => {
    expect(methods["plugins.list"]).toMatchObject({ permission: "pi:admin", idempotent: true });
    for (const name of ["install", "remove", "update", "setEnabled"] as const)
      expect(methods[`plugins.${name}`], name).toMatchObject({ permission: "pi:admin", idempotent: false });
    expect(methods["plugins.install"].errors).toContain("step_up_required");
    expect(methods["plugins.update"].errors).toContain("step_up_required");
    expect(methods["plugins.install"].errors).toContain("protected_path");
    expect(methods["plugins.install"].errors).toContain("forbidden");
  });

  it("bounds the list at 200, refuses a relative installed path and an unknown field", () => {
    const list = methods["plugins.list"].result;
    const many = (n: number) => Array.from({ length: n }, () => view);
    expect(list.safeParse({ plugins: many(PLUGIN_LIMITS.list), truncated: false }).success).toBe(true);
    expect(list.safeParse({ plugins: many(PLUGIN_LIMITS.list + 1), truncated: true }).success).toBe(false);
    expect(list.safeParse({ plugins: [{ ...view, installedPath: null }], truncated: false }).success).toBe(
      true,
    );
    expect(list.safeParse({ plugins: [{ ...view, installedPath: "x/y" }], truncated: false }).success).toBe(
      false,
    );
    expect(list.safeParse({ plugins: [{ ...view, env: {} }], truncated: false }).success).toBe(false);
  });

  it("takes a source and a scope (user or project), the confirmation only as `true`, nothing else", () => {
    const install = methods["plugins.install"].params;
    expect(install.safeParse({ source: "npm:x", scope: "user" }).success).toBe(true);
    expect(
      install.safeParse({ source: "npm:x", scope: "project", cwd: "/w", confirmProtected: true }).success,
    ).toBe(true);
    expect(install.safeParse({ source: "npm:x", scope: "global" }).success).toBe(false);
    expect(install.safeParse({ source: "npm:x", scope: "user", confirmProtected: false }).success).toBe(
      false,
    );
    expect(install.safeParse({ source: "npm:x", scope: "user", flags: "-x" }).success).toBe(false);
    // 2048: the longest accepted remote source is about 600 characters, so a masked one stays addressable (MC55).
    expect(PLUGIN_LIMITS.source).toBe(2048);
    expect(install.safeParse({ source: "x".repeat(2048), scope: "user" }).success).toBe(true);
    expect(install.safeParse({ source: "x".repeat(2049), scope: "user" }).success).toBe(false);
    const update = methods["plugins.update"].params;
    expect(update.safeParse({}).success).toBe(true);
    expect(update.safeParse({ source: "npm:x", scope: "project", confirmProtected: true }).success).toBe(
      true,
    );
  });

  it("takes 1 to 100 switch items", () => {
    const params = methods["plugins.setEnabled"].params;
    const item = { source: "npm:x", scope: "user" };
    expect(params.safeParse({ items: [item], enabled: false }).success).toBe(true);
    expect(params.safeParse({ items: [], enabled: false }).success).toBe(false);
    expect(params.safeParse({ items: Array.from({ length: 100 }, () => item), enabled: true }).success).toBe(
      true,
    );
    expect(params.safeParse({ items: Array.from({ length: 101 }, () => item), enabled: true }).success).toBe(
      false,
    );
  });

  it("declares every code the helper answers, and no row code the helper never produces (MC55)", () => {
    for (const name of ["install", "remove", "update", "setEnabled"] as const)
      for (const code of ["not_found", "config_invalid", "config_path_refused", "conflict"])
        expect(methods[`plugins.${name}`].errors, `${name} ${code}`).toContain(code);
    for (const code of ["bad_request", "config_invalid", "config_path_refused"])
      expect(methods["plugins.list"].errors, code).toContain(code);
    expect(PluginRowCode.options).toEqual(["not_found", "filtered"]);
  });

  it("has the five helper operations", () => {
    for (const op of ["list", "install", "remove", "update", "setEnabled"])
      expect(HELPER_OPS).toHaveProperty([`plugins.${op}`]);
  });
});
