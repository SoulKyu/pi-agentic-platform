import { existsSync, linkSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareProfileContext } from "./image-inputs.ts";
import { ProfileSecretError } from "./secret-scan.ts";
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
const prepare = (secrets: string[] = []) =>
  prepareProfileContext(s.agentDir, s.out, secrets, papHome(), BASE);
const read = (rel: string) => readFileSync(join(s.out, rel), "utf8");

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
        /^local\/pap-profile-\w+: the folder holds or is part of the agent folder, the home, pap's home or the output$/,
      ),
    ]);
  });

  it("refuses a skills folder that is a link to the agent dir", () => {
    const { skipped } = build([], (x) => {
      rmSync(join(x.agentDir, "skills"), { recursive: true });
      symlinkSync(x.agentDir, join(x.agentDir, "skills"));
    });
    expect(skipped).toEqual([
      "skills: the folder holds or is part of the agent folder, the home, pap's home or the output",
    ]);
  });

  it("refuses an npm package that is a link to another part of the agent dir", () => {
    const { skipped } = build(["npm:linked@1.0.0"], (x) => {
      x.json("agent/sessions/package.json", { name: "linked", version: "1.0.0" });
      symlinkSync(join(x.agentDir, "sessions"), join(x.agentDir, "npm/node_modules/linked"));
    });
    expect(skipped).toContain(
      "npm/node_modules/linked: the folder holds or is part of the agent folder, the home, pap's home or the output",
    );
  });

  it("refuses a local package that holds the output folder", () => {
    const { skipped } = build(["../build"]);
    expect(skipped).toEqual([
      "local/build: the folder holds or is part of the agent folder, the home, pap's home or the output",
    ]);
  });
});

describe("roots that hold the home or pap's home (AVM-E28)", () => {
  const HOLDS = "the folder holds or is part of the agent folder, the home, pap's home or the output";
  function withHome(packages: (home: string) => unknown[]) {
    s = scratch();
    plantAgentDir(s);
    const home = join(s.root, "home");
    s.put("home/.bashrc", `${MARKER}-home`);
    s.put("pap-home/vault/key", `${MARKER}-vault`);
    s.put("pap-home/inner/package.json", "{}");
    vi.stubEnv("HOME", home);
    s.json("agent/settings.json", { packages: packages(home) });
    const result = prepare();
    vi.unstubAllEnvs();
    expect(listAll(s.out).filter((entry) => entry.text?.includes(MARKER))).toEqual([]);
    return result;
  }

  it('refuses a root that is $HOME, as "~" and as a path', () => {
    const { skipped } = withHome((home) => ["~", home]);
    expect(skipped).toEqual([`local/home: ${HOLDS}`, `local/home: ${HOLDS}`]);
  });

  it("refuses a root that holds $HOME", () => {
    expect(withHome(() => [".."]).skipped).toHaveLength(1);
  });

  it("refuses pap's home and a folder inside it", () => {
    const { skipped } = withHome(() => [join(s.root, "pap-home"), join(s.root, "pap-home/inner")]);
    expect(skipped).toEqual([`local/pap-home: ${HOLDS}`, `local/inner: ${HOLDS}`]);
  });
});

describe("credential-looking keys only (N1)", () => {
  it("a Content-Type header and NODE_ENV never refuse a build", () => {
    s = scratch();
    plantAgentDir(s);
    s.json("agent/mcp.json", {
      mcpServers: {
        a: {
          command: "/x",
          headers: { "Content-Type": "application/json" },
          env: { NODE_ENV: "production", REGION: "us-east-1" },
        },
      },
    });
    s.json("agent/models.json", {
      providers: {
        acme: {
          api: "openai-completions",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        },
      },
    });
    s.put(
      "agent/skills/hello/SKILL.md",
      "send application/json, text/event-stream, NODE_ENV=production in us-east-1",
    );
    expect(() => prepare()).not.toThrow();
  });

  it("an Authorization header literal of MCP or models.json refuses a file holding it", () => {
    for (const where of ["mcp.json", "models.json"]) {
      s = scratch();
      plantAgentDir(s);
      const header = { Authorization: "Bearer abcdef-0123456789-long" };
      if (where === "mcp.json")
        s.json("agent/mcp.json", { mcpServers: { a: { command: "/x", headers: header } } });
      else
        s.json("agent/models.json", { providers: { acme: { api: "openai-completions", headers: header } } });
      s.put("agent/skills/hello/SKILL.md", "use Bearer abcdef-0123456789-long here");
      expect(() => prepare(), where).toThrow(ProfileSecretError);
      s.cleanup();
    }
  });
});

/*
 * AVM-E30 mutants, each run for real: the userinfo test removed from the MCP env/header rule (the mcp cases); from the
 * provider header rule (the models.json case); the password part left out of the needles ("password only").
 */
describe("a URL that holds userinfo is a secret whatever its key (AVM-E30)", () => {
  const URL_VALUE = "postgres://u:secretpass@h/db";
  const planted = (where: "mcp-env" | "mcp-headers" | "models-headers") => {
    s = scratch();
    plantAgentDir(s);
    if (where === "mcp-env")
      s.json("agent/mcp.json", { mcpServers: { a: { command: "/x", env: { DATABASE_URL: URL_VALUE } } } });
    else if (where === "mcp-headers")
      s.json("agent/mcp.json", {
        mcpServers: { a: { command: "/x", headers: { "X-Upstream": "https://u:secretpass@h/x" } } },
      });
    else
      s.json("agent/models.json", {
        providers: {
          acme: { api: "openai-completions", headers: { "X-Upstream": "https://u:secretpass@h/x" } },
        },
      });
  };

  for (const where of ["mcp-env", "mcp-headers", "models-headers"] as const)
    it(`refuses a copied file that holds only the password (${where})`, () => {
      planted(where);
      s.put("agent/skills/hello/SKILL.md", "connect with secretpass here");
      expect(() => prepare()).toThrow(ProfileSecretError);
    });

  it("refuses a copied file that holds the whole URL", () => {
    planted("mcp-env");
    s.put("agent/skills/hello/SKILL.md", `url ${URL_VALUE}`);
    expect(() => prepare()).toThrow(ProfileSecretError);
  });

  it("a URL without userinfo, an address and a variable reference never refuse a build", () => {
    s = scratch();
    plantAgentDir(s);
    s.json("agent/mcp.json", {
      mcpServers: {
        a: {
          command: "/x",
          env: {
            DATABASE_URL: "postgres://h:5432/db",
            CONTACT: "ops@example.test",
            PROXY: "http://${PROXY_USER}:${PROXY_PASS}@h/",
          },
          headers: { "X-Upstream": "https://example.test/path?next=a@b" },
        },
      },
    });
    s.put("agent/skills/hello/SKILL.md", "postgres://h:5432/db ops@example.test https://example.test/path");
    expect(() => prepare()).not.toThrow();
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
