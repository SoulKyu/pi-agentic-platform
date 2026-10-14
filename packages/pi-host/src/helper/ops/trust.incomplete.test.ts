import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRUST_LIMITS, TrustStatus } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { trustSet, trustStatus } from "./trust.ts";

// trust.status never looks complete when it is not (MC47 I2): what pap does not list is named in `unlisted`.
let root: string;
let home: string;
let agentDir: string;
let cwd: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-trust-inc-")));
  home = join(root, "home");
  agentDir = join(home, ".pi", "agent");
  cwd = join(home, "repo", "packages", "app");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
});
afterEach(() => {
  chmodSync(join(cwd, ".pi"), 0o755);
  rmSync(root, { recursive: true, force: true });
});

const ctx = (target = cwd) => ({ agentDir, papHome: join(root, "pap"), home, cwd: target });
const status = async () => {
  const answer = await trustStatus(ctx());
  expect(TrustStatus.safeParse(answer).success).toBe(true);
  return answer.resources;
};

describe("trust.status: what it could not list", () => {
  it("says so for an MCP file of 201 servers and for an extensions folder that links out of the folder", async () => {
    const servers = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`s${i}`, { command: "node" }]));
    writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: servers }));
    const tools = join(root, "home", "repo", "tools", "ext");
    mkdirSync(tools, { recursive: true });
    writeFileSync(join(tools, "evil.ts"), "");
    symlinkSync(tools, join(cwd, ".pi", "extensions"));
    writeFileSync(join(cwd, ".pi", "ok.md"), "");
    const resources = await status();
    expect(resources.mcpServers).toEqual([]);
    expect(resources.extensions).toEqual([]);
    expect(resources.unlisted).toEqual([
      ".pi/extensions: link leaving the folder, not listed",
      ".pi/mcp.json: not listed (too-many-servers)",
    ]);
    expect(JSON.stringify(resources)).not.toContain("evil.ts");
  });

  it("says so for a settings file that cannot be read or is not an object, and for a prompts folder that cannot be read", async () => {
    writeFileSync(join(cwd, ".pi", "settings.json"), "[1]");
    expect((await status()).unlisted).toEqual([".pi/settings.json: is not an object"]);
    writeFileSync(join(cwd, ".pi", "settings.json"), "{ nope");
    expect((await status()).unlisted).toEqual([".pi/settings.json: cannot be read or is not JSON"]);
    rmSync(join(cwd, ".pi", "settings.json"));
    mkdirSync(join(cwd, ".pi", "prompts"));
    if (process.getuid?.() !== 0) {
      chmodSync(join(cwd, ".pi", "prompts"), 0o000);
      expect((await status()).unlisted).toEqual([".pi/prompts: cannot be read"]);
      chmodSync(join(cwd, ".pi", "prompts"), 0o755);
    }
  });

  it("says nothing is unlisted for a plain project, and not for a folder that is simply absent", async () => {
    mkdirSync(join(cwd, ".pi", "extensions"));
    writeFileSync(join(cwd, ".pi", "extensions", "x.ts"), "");
    const resources = await status();
    expect(resources.extensions).toEqual(["x.ts"]);
    expect(resources.unlisted).toEqual([]);
    expect(resources.truncated).toBe(false);
  });

  it("flags a folder with more entries than the scan reads as cut", async () => {
    mkdirSync(join(cwd, ".pi", "extensions"));
    for (let i = 0; i < 1001; i++) writeFileSync(join(cwd, ".pi", "extensions", `e${i}.ts`), "");
    const resources = await status();
    expect(resources.truncated).toBe(true);
    expect(resources.unlisted).toEqual([".pi/extensions: more entries than are read"]);
  });
});

describe("trust.status: every list cap, crossed", () => {
  it("cuts skills at the cap and says so", async () => {
    for (let i = 0; i < TRUST_LIMITS.skills + 5; i++)
      mkdirSync(join(cwd, ".agents", "skills", `s${String(i).padStart(3, "0")}`), { recursive: true });
    const resources = await status();
    expect(resources.skills).toHaveLength(TRUST_LIMITS.skills);
    expect(resources.truncated).toBe(true);
  });

  it("cuts setting keys at the cap and says so", async () => {
    const keys = Object.fromEntries(
      Array.from({ length: TRUST_LIMITS.settingsKeys + 5 }, (_, i) => [`k${i}`, i]),
    );
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(keys));
    const resources = await status();
    expect(resources.settingsKeys).toHaveLength(TRUST_LIMITS.settingsKeys);
    expect(resources.truncated).toBe(true);
  });
});

describe("trust.set: a link to the home folder", () => {
  it("is refused by its real path, whatever the spelling", async () => {
    const alias = join(root, "innocent");
    symlinkSync(home, alias);
    expect(await trustSet({ decision: true, projects: [] }, ctx(alias))).toEqual({
      ok: false,
      refusal: "home-or-above",
    });
    const aboveAlias = join(root, "above");
    symlinkSync(root, aboveAlias);
    expect(await trustSet({ decision: true, projects: [] }, ctx(aboveAlias))).toEqual({
      ok: false,
      refusal: "home-or-above",
    });
  });
});
