import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AdapterInput, applyAdapter } from "./adapters.ts";
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
  it("pi-claude-bridge: base url on the relay's port, no token anywhere", () => {
    const i = input();
    applyAdapter("pi-claude-bridge", i);
    expect(read("pi-claude-bridge.json")).toEqual({
      env: { ANTHROPIC_BASE_URL: "http://claude.internal:7842" },
    });
    expect(readFileSync(join(s.out, "pi-claude-bridge.json"), "utf8")).not.toMatch(/TOKEN|token/);
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
