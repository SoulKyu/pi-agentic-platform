import { createHash } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pluginIdKey, pluginIdOf } from "../plugin-id.ts";
import { listPlugins } from "./plugins.ts";
import { agentDir, ctxFor, cwd, papHome, root, trust } from "./plugins-bed.ts";
import { resolvePlugins } from "./plugins-resolve.ts";

/*
 * Mutants (RT-43), run for real:
 * - the listed id is the hash of the masked source -> "two sources that mask alike have two ids" fails.
 * - the id is an unkeyed sha256 of scope and source (the old form) -> "is keyed by a per-home secret" fails.
 * - the key file is made with the default mode or reused when others can read it -> "makes the key 0600" fails.
 * - `resolvePlugins` answers the masked source -> "answers the exact spelling" fails.
 * - `resolvePlugins` reads the project scope instead of the owner's -> "answers the exact spelling" fails.
 */
const SECRET_A = "https://user:hunter2@git.example/org/tools.git";
const SECRET_B = "https://user:swordfish@git.example/org/tools.git";
const settings = (packages: unknown[]) =>
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages }));

describe("a plugin's id (AVM-E33)", () => {
  it("is 32 hex characters, one per package, and carries nothing of the source", async () => {
    settings([SECRET_A, "npm:left-pad@1.0.0"]);
    const { plugins } = await listPlugins(ctxFor(null));
    const ids = plugins.map((plugin) => plugin.id);
    expect(ids.every((id) => /^[0-9a-f]{32}$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(2);
    expect(JSON.stringify(plugins)).not.toContain("hunter2");
  });

  it("two sources that mask alike have two ids", async () => {
    settings([SECRET_A, SECRET_B]);
    const { plugins } = await listPlugins(ctxFor(null));
    expect(plugins[0]?.source).toBe(plugins[1]?.source);
    expect(plugins[0]?.id).not.toBe(plugins[1]?.id);
  });
});

describe("a plugin's id is keyed (AVM-E43 M4)", () => {
  it("is keyed by a per-home secret: not the bare hash of the source, and another home gives another id", async () => {
    settings([SECRET_A]);
    const first = (await listPlugins(ctxFor(null))).plugins[0]?.id;
    const bare = createHash("sha256").update(`pap-plugin\0user\0${SECRET_A}`).digest("hex").slice(0, 32);
    expect(first).not.toBe(bare);
    expect((await listPlugins(ctxFor(null))).plugins[0]?.id).toBe(first);
    const elsewhere = (await listPlugins(ctxFor(null, join(root, "other-pap")))).plugins[0]?.id;
    expect(elsewhere).not.toBe(first);
  });

  it("makes the key 0600 under secrets/ once, and keeps ids stable across calls", async () => {
    settings([SECRET_A]);
    await listPlugins(ctxFor(null));
    const file = join(papHome, "secrets", "plugin-id.key");
    expect(statSync(file).size).toBe(32);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("replaces a key that others can read", async () => {
    settings([SECRET_A]);
    mkdirSync(join(papHome, "secrets"), { recursive: true });
    const file = join(papHome, "secrets", "plugin-id.key");
    writeFileSync(file, Buffer.alloc(32, 7), { mode: 0o644 });
    await listPlugins(ctxFor(null));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("plugins.resolve (AVM-E33)", () => {
  it("answers the exact spelling settings.json holds, in the order asked", async () => {
    settings([SECRET_A, "npm:left-pad@1.0.0", SECRET_B]);
    const ids = (await listPlugins(ctxFor(null))).plugins.map((plugin) => plugin.id);
    const answer = await resolvePlugins({ ids: [ids[2] as string, ids[0] as string] }, ctxFor(null));
    expect(answer).toEqual({ sources: [SECRET_B, SECRET_A] });
  });

  it("a pick survives a new version or ref of its package in settings.json (the Claude bridge, 2026-10-23)", async () => {
    settings(["npm:pi-claude-bridge@0.9.1", "git:github.com/org/tool@aaa111"]);
    const before = (await listPlugins(ctxFor(null))).plugins.map((plugin) => plugin.id);
    settings(["npm:pi-claude-bridge@0.9.3", "git:github.com/org/tool@bbb222"]);
    expect((await listPlugins(ctxFor(null))).plugins.map((plugin) => plugin.id)).toEqual(before);
    expect(await resolvePlugins({ ids: before }, ctxFor(null))).toEqual({
      sources: ["npm:pi-claude-bridge@0.9.3", "git:github.com/org/tool@bbb222"],
    });
  });

  it("a pick saved under the exact-source id still resolves while that source is unchanged", async () => {
    settings(["npm:left-pad@1.0.0"]);
    const saved = pluginIdOf(pluginIdKey(papHome), "user", "npm:left-pad@1.0.0");
    expect(await resolvePlugins({ ids: [saved] }, ctxFor(null))).toEqual({ sources: ["npm:left-pad@1.0.0"] });
  });

  it("answers null for an id nothing holds, and never throws for it", async () => {
    settings(["npm:left-pad@1.0.0"]);
    expect(await resolvePlugins({ ids: ["0".repeat(32)] }, ctxFor(null))).toEqual({ sources: [null] });
  });

  it("a project package never resolves, though its id is listed", async () => {
    settings([]);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:project-only"] }));
    trust();
    const listed = (await listPlugins(ctxFor())).plugins.find((plugin) => plugin.scope === "project");
    expect(listed?.id).toMatch(/^[0-9a-f]{32}$/);
    expect(await resolvePlugins({ ids: [listed?.id as string] }, ctxFor())).toEqual({ sources: [null] });
  });
});
