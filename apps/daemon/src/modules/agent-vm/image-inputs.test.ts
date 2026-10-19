import { existsSync, linkSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
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
const prepare = (secrets: string[] = []) => prepareProfileContext(s.agentDir, s.out, secrets);
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
    expect(() => prepareProfileContext(s.agentDir, join(s.agentDir, "pi-agent"), [])).toThrow(/output/);
    expect(() => prepareProfileContext(s.agentDir, s.root, [])).toThrow(/output/);
    expect(() => prepareProfileContext(s.agentDir, "relative/out", [])).toThrow(/output/);
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

describe("a copied root may not be, or hold, the agent folder (RT-18)", () => {
  const FORBIDDEN = [
    "sessions",
    "mem0",
    "pi-web-session-index.json",
    "auth.json",
    "mcp-auth.json",
    ".credentials.json",
  ];
  function build(packages: unknown[] | ((x: Scratch) => unknown[]), extra: (s: Scratch) => void = () => {}) {
    s = scratch();
    plantAgentDir(s);
    s.json("agent/mcp-auth.json", { srv: { access_token: `${MARKER}-oauth` } });
    s.json("agent/settings.json", { packages: typeof packages === "function" ? packages(s) : packages });
    extra(s);
    const result = prepare();
    const all = listAll(s.out);
    expect(all.filter((entry) => entry.text?.includes(MARKER))).toEqual([]);
    expect(all.filter((entry) => entry.rel.split("/").some((part) => FORBIDDEN.includes(part)))).toEqual([]);
    expect(all.some((entry) => entry.rel.split("/").includes(".."))).toBe(false);
    return result;
  }

  it('refuses "." (a value Pi writes for a local install) and reports it', () => {
    expect(build(["."]).skipped).toEqual(["local/agent: a local package inside the agent folder"]);
  });

  it("refuses the absolute agent dir", () => {
    expect(build((x) => [x.agentDir]).skipped).toEqual([
      "local/agent: a local package inside the agent folder",
    ]);
  });

  it('refuses ".." (it holds the agent dir and the output)', () => {
    const { skipped } = build([".."]);
    expect(skipped).toEqual([
      expect.stringMatching(
        /^local\/pap-profile-\w+: the folder holds or is part of the agent folder, the home or the output$/,
      ),
    ]);
  });

  it("refuses a skills folder that is a link to the agent dir", () => {
    const { skipped } = build([], (x) => {
      rmSync(join(x.agentDir, "skills"), { recursive: true });
      symlinkSync(x.agentDir, join(x.agentDir, "skills"));
    });
    expect(skipped).toEqual([
      "skills: the folder holds or is part of the agent folder, the home or the output",
    ]);
  });

  it("refuses an npm package that is a link to another part of the agent dir", () => {
    const { skipped } = build(["npm:linked@1.0.0"], (x) => {
      x.json("agent/sessions/package.json", { name: "linked", version: "1.0.0" });
      symlinkSync(join(x.agentDir, "sessions"), join(x.agentDir, "npm/node_modules/linked"));
    });
    expect(skipped).toContain(
      "npm/node_modules/linked: the folder holds or is part of the agent folder, the home or the output",
    );
  });

  it("refuses a local package that holds the output folder", () => {
    const { skipped } = build(["../build"]);
    expect(skipped).toEqual([
      "local/build: the folder holds or is part of the agent folder, the home or the output",
    ]);
  });
});

describe("npm closure", () => {
  const withDeps = (s2: Scratch) => {
    s2.json("agent/npm/node_modules/demo-pkg/package.json", {
      name: "demo-pkg",
      version: "1.2.3",
      optionalDependencies: { "opt-installed": "1.0.0", "opt-missing": "1.0.0" },
      peerDependencies: { "peer-installed": "*", "peer-missing": "*" },
    });
    for (const name of ["opt-installed", "peer-installed"]) {
      s2.json(`agent/npm/node_modules/${name}/package.json`, { name, version: "1.0.0" });
      s2.put(`agent/npm/node_modules/${name}/.npmrc`, MARKER);
      s2.put(`agent/npm/node_modules/${name}/bin/claude`, "binary");
    }
  };

  it("follows installed optional and peer dependencies through the same copy and notes a missing optional one", () => {
    s = scratch();
    plantAgentDir(s);
    withDeps(s);
    const { skipped } = prepare();
    const names = listAll(s.out).map((entry) => entry.rel);
    expect(names).toContain("npm/node_modules/opt-installed/bin/claude");
    expect(names).toContain("npm/node_modules/peer-installed/bin/claude");
    expect(names).not.toContain("npm/node_modules/opt-installed/.npmrc");
    expect(skipped).toContain("npm:opt-missing: optional dependency not installed");
    expect(skipped.filter((note) => note.includes("peer-missing"))).toEqual([]);
  });

  it("scans an optional dependency like any copied file", () => {
    s = scratch();
    plantAgentDir(s);
    withDeps(s);
    s.put("agent/npm/node_modules/opt-installed/bin/claude", `x ${VAULT_VALUE}`);
    expect(() => prepare([VAULT_VALUE])).toThrow(ProfileSecretError);
  });
});

describe("known secrets and notes", () => {
  it("a models.json that names credentials by environment variable or command builds, with that text in a README", () => {
    s = scratch();
    plantAgentDir(s);
    s.json("agent/models.json", {
      providers: {
        acme: {
          api: "openai-completions",
          apiKey: "$OPENAI_API_KEY",
          headers: { a: "${ACME_TOKEN_VALUE}", b: "!pass show acme/token" },
        },
      },
    });
    s.put(
      "agent/skills/hello/README.md",
      "set $OPENAI_API_KEY and ${ACME_TOKEN_VALUE} and run !pass show acme/token",
    );
    expect(() => prepare()).not.toThrow();
  });

  it("the web-search key, MCP env values and MCP OAuth tokens of the owner are known secrets", () => {
    for (const planted of [`${MARKER}-exa`, `${MARKER}-mcp-env`, `${MARKER}-oauth`]) {
      s = scratch();
      plantAgentDir(s);
      s.json("agent/mcp-auth.json", { srv: { access_token: `${MARKER}-oauth` } });
      s.put("agent/skills/hello/SKILL.md", `leak ${planted}`);
      expect(() => prepare()).toThrow(ProfileSecretError);
      s.cleanup();
    }
  });

  it("withholds a skip note that holds a known secret", () => {
    s = scratch();
    plantAgentDir(s);
    s.json("agent/mcp.json", { mcpServers: { "server-with-secret-name": { command: "/usr/bin/true" } } });
    const { skipped } = prepare(["server-with-secret-name"]);
    expect(skipped).toContain("[note withheld]");
    expect(skipped.join("\n")).not.toContain("server-with-secret-name");
  });

  it("skips a hard link to auth.json under any name", () => {
    s = scratch();
    plantAgentDir(s);
    linkSync(join(s.agentDir, "auth.json"), join(s.agentDir, "npm/node_modules/demo-pkg/lib/data.dat"));
    s.put("agent/npm/node_modules/demo-pkg/.gitconfig", MARKER);
    s.put("agent/npm/node_modules/demo-pkg/mcp-auth.json", MARKER);
    prepare();
    expect(existsSync(join(s.out, "npm/node_modules/demo-pkg/lib/data.dat"))).toBe(false);
    expect(listAll(s.out).filter((entry) => entry.text?.includes(MARKER))).toEqual([]);
  });
});

describe("settings skills entries", () => {
  it("keeps exclusion entries of copied skills, rewritten, and reports each entry it cannot keep", () => {
    s = scratch();
    plantAgentDir(s);
    s.put("agent/skills/hello/draft.md", "d");
    s.json("agent/settings.json", {
      skills: [
        "skills/hello",
        "!skills/hello/draft.md",
        "-skills/hello/SKILL.md",
        "+skills/hello",
        "!skills/old/**",
        "!../../etc/*",
        `!${s.outside}/x`,
        "/etc/passwd",
        7,
      ],
    });
    const { skipped } = prepare();
    expect((JSON.parse(read("settings.json")) as { skills: string[] }).skills).toEqual([
      "skills/hello",
      "!skills/hello/draft.md",
      "-skills/hello/SKILL.md",
      "+skills/hello",
      "!skills/old/**",
    ]);
    expect(skipped.filter((note) => note.startsWith("settings.json: a skills entry"))).toHaveLength(4);
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
