import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listPlugins } from "./plugins.ts";
import { agentDir, ctxFor, cwd, trust } from "./plugins-bed.ts";
import { resolvePlugins } from "./plugins-resolve.ts";

/*
 * Mutants (RT-43), run for real:
 * - the listed id is the hash of the masked source -> "two sources that mask alike have two ids" fails.
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

describe("plugins.resolve (AVM-E33)", () => {
  it("answers the exact spelling settings.json holds, in the order asked", async () => {
    settings([SECRET_A, "npm:left-pad@1.0.0", SECRET_B]);
    const ids = (await listPlugins(ctxFor(null))).plugins.map((plugin) => plugin.id);
    const answer = await resolvePlugins({ ids: [ids[2] as string, ids[0] as string] }, ctxFor(null));
    expect(answer).toEqual({ sources: [SECRET_B, SECRET_A] });
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
