import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AdapterInput, adapterSecrets, applyAdapter } from "./adapters.ts";
import { IMAGE_AGENT_DIR } from "./profile-allowlist.ts";
import { MARKER, type Scratch, scratch } from "./testing/profile-fixture.ts";

let s: Scratch;
afterEach(() => s?.cleanup());
const read = (name: string) => JSON.parse(readFileSync(join(s.out, name), "utf8")) as unknown;

function input(): AdapterInput {
  s = scratch();
  mkdirSync(s.out, { recursive: true });
  s.put("agent/npm/node_modules/demo-pkg/bin/server.js", "x");
  const src = realpathSync(join(s.agentDir, "npm/node_modules/demo-pkg"));
  return {
    agentDir: realpathSync(s.agentDir),
    out: s.out,
    roots: [{ src, dst: "npm/node_modules/demo-pkg" }],
    skipped: [],
  };
}

describe("adapters", () => {
  // AVM-E25: the worker exports the bridge's base URL and token (relay-key.ts); no config file is written for it.
  it("pi-claude-bridge: no adapter, nothing written", () => {
    const i = input();
    s.json("agent/claude-bridge.json", { token: `${MARKER}-bridge` });
    applyAdapter("pi-claude-bridge", i);
    expect(readdirSync(s.out)).toEqual([]);
    expect(i.skipped).toEqual([]);
  });

  it("pi-web-access: placeholder keys only, nothing else of the original", () => {
    const i = input();
    s.json("agent/web-search.json", {
      exaApiKey: `${MARKER}-exa`,
      perplexityKey: "k",
      provider: "exa",
      nested: { a: 1 },
    });
    applyAdapter("pi-web-access", i);
    expect(read("web-search.json")).toEqual({
      exaApiKey: "pap-placeholder",
      perplexityKey: "pap-placeholder",
    });
  });

  it("pi-web-access: an absent or damaged original gives an empty config", () => {
    const i = input();
    applyAdapter("pi-web-access", i);
    expect(read("web-search.json")).toEqual({});
    s.put("agent/web-search.json", "{nope");
    applyAdapter("pi-web-access", i);
    expect(read("web-search.json")).toEqual({});
  });

  it("pi-mcp-adapter: keeps a stdio server whose binary is inside a copied package, drops the rest", () => {
    const i = input();
    s.json("agent/mcp.json", {
      mcpServers: {
        inside: {
          command: join(i.agentDir, "npm/node_modules/demo-pkg/bin/server.js"),
          args: ["--x", 3],
          env: { T: `${MARKER}-env` },
          cwd: "/etc",
        },
        outside: { command: "/usr/bin/true" },
        bare: { command: "npx", args: ["x"] },
        remote: { url: "https://mcp.test/sse", headers: { a: `${MARKER}-h` } },
        "../bad": { command: join(i.agentDir, "npm/node_modules/demo-pkg/bin/server.js") },
      },
    });
    applyAdapter("pi-mcp-adapter", i);
    expect(read("mcp.json")).toEqual({
      mcpServers: {
        inside: { command: `${IMAGE_AGENT_DIR}/npm/node_modules/demo-pkg/bin/server.js`, args: ["--x"] },
      },
    });
    expect(i.skipped.sort()).toEqual([
      "mcp:../bad: name",
      "mcp:bare: not a packaged binary",
      "mcp:outside: not a packaged binary",
      "mcp:remote: not stdio",
    ]);
  });

  it("pi-mcp-adapter: no original config writes nothing", () => {
    const i = input();
    applyAdapter("pi-mcp-adapter", i);
    expect(existsSync(join(s.out, "mcp.json"))).toBe(false);
  });

  it("an unknown package enters without its config", () => {
    const i = input();
    s.json("agent/demo-pkg.json", { k: MARKER });
    applyAdapter("demo-pkg", i);
    expect(existsSync(join(s.out, "demo-pkg.json"))).toBe(false);
    expect(i.skipped).toEqual([]);
  });
});

describe("adapterSecrets", () => {
  it("collects literal web-search keys, MCP env and header values and MCP OAuth tokens, not the non-literal forms", () => {
    input();
    s.json("agent/web-search.json", {
      exaApiKey: "exa-literal-0001",
      other: "not-a-key-value",
      envKey: "$EXA_KEY",
    });
    s.json("agent/mcp.json", {
      mcpServers: {
        a: {
          command: "x",
          env: {
            API_TOKEN: "env-literal-0002",
            U_TOKEN: "${TOKEN_VAR}",
            NODE_ENV: "production",
            REGION: "us-east-1",
          },
          headers: {
            Authorization: "header-literal-0003",
            "X-Api-Key": "!pass show x",
            "Content-Type": "application/json",
          },
        },
        b: { env: "oops", headers: null },
      },
    });
    s.json("agent/mcp-auth.json", {
      srv: {
        tokens: { access_token: "oauth-literal-0004", token_type: "bearer" },
        url: "https://x.test/mcp",
      },
    });
    expect(adapterSecrets(s.agentDir).sort()).toEqual([
      "env-literal-0002",
      "exa-literal-0001",
      "header-literal-0003",
      "oauth-literal-0004",
    ]);
  });

  it("an absent or damaged config gives nothing", () => {
    input();
    s.put("agent/mcp.json", "{nope");
    expect(adapterSecrets(s.agentDir)).toEqual([]);
  });
});

describe("the credential vocabulary", () => {
  // The daemon reads the list from @pap/contracts (credentialName); pi-host's MCP masker re-exports the same one.
  it("pi-host's credential-words file still re-exports contracts' list, so both maskers agree", () => {
    const text = readFileSync(
      join(import.meta.dirname, "../../../../../packages/pi-host/src/helper/credential-words.ts"),
      "utf8",
    );
    expect(text).toContain('export { COMMENT_WORD, CREDENTIAL_WORDS, credentialName } from "@pap/contracts"');
  });
});
