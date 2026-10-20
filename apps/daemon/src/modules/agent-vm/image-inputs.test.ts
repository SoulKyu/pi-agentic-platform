import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { IMAGE_TAG } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { agentLayerTag, prepareProfileContext } from "./image-inputs.ts";
import { PROFILE_SECRET_NOTICE, ProfileSecretError } from "./secret-scan.ts";
import {
  listAll,
  MARKER,
  plantAgentDir,
  type Scratch,
  scratch,
  VAULT_VALUE,
} from "./testing/profile-fixture.ts";

/*
 * Fix-round mutants, each run for real: roots guard removed (the "may not be, or hold" cases); optional/peer dependencies
 * not followed ("npm closure"); auth.json inode check removed ("hard link"); notes not withheld ("withholds a skip note");
 * `$NAME`/`!command` taken as literals ("environment variable or command"); adapter secrets left out of the needles;
 * local-inside-agent check removed ("." and the absolute agent dir).
 */
let s: Scratch;
afterEach(() => s?.cleanup());
const papHome = () => join(s.root, "pap-home");
const BASE = `pap-agent-base-${"c".repeat(64)}`;
const prepare = (secrets: string[] = [], base = BASE) =>
  prepareProfileContext(s.agentDir, s.out, secrets, papHome(), base);
const read = (rel: string) => readFileSync(join(s.out, rel), "utf8");

describe("prepareProfileContext (RT-18)", () => {
  it("keeps every planted secret out: no such file name, no such content", () => {
    s = scratch();
    plantAgentDir(s);
    const { tag } = prepare();
    expect(tag).toMatch(IMAGE_TAG);
    const all = listAll(s.out);
    const names = all.map((entry) => entry.rel);
    for (const banned of [
      "auth.json",
      "sessions",
      "mem0",
      "pi-web-session-index.json",
      ".credentials.json",
      ".env",
      "foo.json",
      ".git",
      ".npmrc",
      "key.pem",
      "id_rsa",
      ".env.local",
      "link-out",
    ])
      expect(names.filter((n) => n.split("/").includes(banned))).toEqual([]);
    expect(all.filter((entry) => entry.text?.includes(MARKER)).map((entry) => entry.rel)).toEqual([]);
    expect(names).toContain("npm/node_modules/demo-pkg/lib/a.js");
    expect(readlinkSync(join(s.out, "npm/node_modules/demo-pkg/link-in"))).toBe("lib/a.js");
  });

  // Mutant "allowlist widened": copying the whole agent dir would bring foo.json, auth.json, sessions.
  it("writes a sanitized settings.json and rewrites package sources", () => {
    s = scratch();
    plantAgentDir(s);
    prepare();
    expect(JSON.parse(read("settings.json"))).toEqual({
      compaction: { enabled: true },
      defaultThinkingLevel: "high",
      defaultProvider: "acme",
      defaultModel: "m1",
      enabledModels: ["acme/m1"],
      packages: [
        "npm:pi-claude-bridge@1.0.0",
        "npm:pi-web-access@2.0.0",
        "npm:pi-mcp-adapter@3.0.0",
        "npm:demo-pkg@1.2.3",
        "git:github.com/acme/tool@v1",
        "local/localpkg",
      ],
      skills: ["skills/hello"],
    });
    expect(listAll(s.out).map((entry) => entry.rel)).toEqual(
      expect.arrayContaining([
        "git/github.com/acme/tool/package.json",
        "local/localpkg/x.js",
        "skills/hello/SKILL.md",
        "npm/node_modules/dep-one/package.json",
      ]),
    );
  });

  // Mutant "pi-mem0 copied".
  it("never copies pi-mem0 and reports it", () => {
    s = scratch();
    plantAgentDir(s);
    const { skipped } = prepare();
    expect(listAll(s.out).filter((entry) => entry.rel.includes("mem0"))).toEqual([]);
    expect(skipped).toContain("pi-mem0: R17, memory stays out of VM images");
    expect(read("settings.json")).not.toContain("mem0");
  });

  it("generates models.json against the relay, no headers, every URL on port 7842", () => {
    s = scratch();
    plantAgentDir(s);
    prepare();
    const text = read("models.json");
    expect(text).not.toContain("header");
    expect(text).not.toContain(MARKER);
    const models = JSON.parse(text) as { providers: Record<string, { baseUrl: string; apiKey: string }> };
    expect(Object.keys(models.providers)).toEqual(["acme"]);
    expect(models.providers.acme).toMatchObject({
      baseUrl: "http://llm.internal:7842/acme",
      apiKey: "pap-placeholder",
    });
    const urls = listAll(s.out).flatMap(
      (entry) => entry.text?.match(/https?:\/\/[a-z.]+\.internal[:\d]*/g) ?? [],
    );
    expect(urls).toEqual(["http://llm.internal:7842"]);
    for (const url of urls) expect(url).toMatch(/:7842$/);
  });

  it("runs the adapters", () => {
    s = scratch();
    plantAgentDir(s);
    const { skipped } = prepare();
    expect(existsSync(join(s.out, "pi-claude-bridge.json"))).toBe(false);
    expect(JSON.parse(read("web-search.json"))).toEqual({ exaApiKey: "pap-placeholder" });
    expect(Object.keys((JSON.parse(read("mcp.json")) as { mcpServers: object }).mcpServers)).toEqual([
      "inside",
    ]);
    expect(skipped).toContain("mcp:outside: not a packaged binary");
    expect(skipped).toContain("npm/node_modules/demo-pkg/link-out: link");
  });

  it("refuses a build when a package file holds the vault's value, naming the file", () => {
    s = scratch();
    plantAgentDir(s);
    s.put("agent/npm/node_modules/demo-pkg/lib/config.js", `const k = "${VAULT_VALUE}";`);
    let error: unknown;
    try {
      prepare([VAULT_VALUE]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ProfileSecretError);
    expect((error as ProfileSecretError).file).toBe("npm/node_modules/demo-pkg/lib/config.js");
    expect((error as Error).message).toContain(PROFILE_SECRET_NOTICE);
    expect((error as Error).message).not.toContain(VAULT_VALUE);
    expect(existsSync(s.out)).toBe(false);
  });

  it("scans the literal header and apiKey values of models.json as known secrets", () => {
    s = scratch();
    plantAgentDir(s);
    s.put("agent/skills/hello/SKILL.md", `use ${MARKER}-header-literal here`);
    expect(() => prepare()).toThrow(ProfileSecretError);
    s.put("agent/skills/hello/SKILL.md", `use ${MARKER}-literal-api-key here`);
    expect(() => prepare()).toThrow(ProfileSecretError);
  });

  it("is deterministic and a package version change changes the tag", () => {
    s = scratch();
    plantAgentDir(s);
    const first = prepare().tag;
    expect(prepare().tag).toBe(first);
    s.cleanup();
    s = scratch();
    plantAgentDir(s, "1.2.4");
    expect(prepare().tag).not.toBe(first);
  });

  // Mutant "base tag left out of the profile tag": a new bundle or a weekly rebuild would not reach the profile image.
  it("a new base tag changes the profile tag, and through it the agent layer's tag (base tag)", () => {
    s = scratch();
    plantAgentDir(s);
    const first = prepare().tag;
    expect(prepare([], BASE).tag).toBe(first);
    const other = prepare([], `pap-agent-base-${"d".repeat(64)}`).tag;
    expect(other).not.toBe(first);
    expect(agentLayerTag(other, ["jq"])).not.toBe(agentLayerTag(first, ["jq"]));
  });

  it("refuses a base tag that is not a base tag", () => {
    s = scratch();
    plantAgentDir(s);
    expect(() => prepare([], "latest")).toThrow(/base tag/);
    expect(() => prepare([], `pap-agent-profile-${"c".repeat(64)}`)).toThrow(/base tag/);
    expect(existsSync(s.out)).toBe(false);
  });

  it("skips a package whose installed version differs from the pinned one", () => {
    s = scratch();
    plantAgentDir(s);
    s.json("agent/npm/node_modules/demo-pkg/package.json", { name: "demo-pkg", version: "9.9.9" });
    const { skipped } = prepare();
    expect(skipped).toContain("npm:demo-pkg: installed version differs from the pinned one");
    expect(read("settings.json")).not.toContain("demo-pkg");
  });

  it("refuses an output folder that overlaps the agent dir", () => {
    s = scratch();
    plantAgentDir(s);
    expect(() =>
      prepareProfileContext(s.agentDir, join(s.agentDir, "pi-agent"), [], papHome(), BASE),
    ).toThrow(/output/);
    expect(() => prepareProfileContext(s.agentDir, s.root, [], papHome(), BASE)).toThrow(/output/);
    expect(() => prepareProfileContext(s.agentDir, "relative/out", [], papHome(), BASE)).toThrow(/output/);
  });

  it("works on an empty agent dir", () => {
    s = scratch();
    s.put("agent/.keep", "");
    const { tag, skipped } = prepare();
    expect(tag).toMatch(IMAGE_TAG);
    expect(skipped).toEqual([]);
    expect(JSON.parse(read("models.json"))).toEqual({ providers: {} });
    expect(JSON.parse(read("settings.json"))).toEqual({});
  });
});

describe("agentLayerTag", () => {
  const profile = `pap-agent-profile-${"a".repeat(64)}`;
  it("is the profile tag without system packages, else a stable agent tag", () => {
    expect(agentLayerTag(profile, [])).toBe(profile);
    const tag = agentLayerTag(profile, ["jq", "git"]);
    expect(tag).toMatch(IMAGE_TAG);
    expect(tag).toMatch(/^pap-agent-agent-/);
    expect(agentLayerTag(profile, ["git", "jq", "git"])).toBe(tag);
    expect(agentLayerTag(profile, ["git"])).not.toBe(tag);
    expect(agentLayerTag(`pap-agent-profile-${"b".repeat(64)}`, ["jq", "git"])).not.toBe(tag);
  });
});
