import { McpServerView } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { MASK } from "./mask.ts";
import { McpEntry, maskMcpEntry } from "./mcp-entry.ts";

const view = (name: string, raw: unknown, scope: "global" | "project" = "global") =>
  maskMcpEntry(name, raw, scope);

describe("maskMcpEntry: a stdio server", () => {
  const raw = {
    command: "npx",
    args: ["-y", "@acme/server", "--token", "tok-literal-1", "--api-key=sk-live-123"],
    env: { API_KEY: "sk-literal-env", TOKEN: "!gh auth token", HOME_DIR: "${HOME}" },
    cwd: "~/work",
    exposure: "direct",
    toolExposure: { "get_*": "codemode", delete_all: "hidden" },
  };

  it("keeps names, masks the command line word by word and drops every value", () => {
    const v = view("acme", raw);
    expect(McpServerView.parse(v)).toEqual(v);
    expect(v).toMatchObject({
      name: "acme",
      scope: "global",
      kind: "stdio",
      enabled: true,
      exposure: "direct",
      target: `npx -y @acme/server --token ${MASK} --api-key=${MASK}`,
      cwd: "~/work",
      envNames: ["API_KEY", "TOKEN", "HOME_DIR"],
      headerNames: [],
      commandFields: ["env.TOKEN"],
      variables: ["HOME"],
      oauth: false,
      toolExposureCount: 2,
      state: "on",
      lastTest: null,
      problem: null,
    });
    const text = JSON.stringify(v);
    for (const value of ["tok-literal-1", "sk-live-123", "sk-literal-env", "gh auth token"])
      expect(text).not.toContain(value);
  });

  it("does not read the words of a !command value as variables", () => {
    const v = view("a", { command: "x", env: { RUN: "!echo $HOME_DIR ${OTHER}", PLAIN: "$KEPT" } });
    expect(v.variables).toEqual(["KEPT"]);
    expect(v.commandFields).toEqual(["env.RUN"]);
  });

  it("is disabled when enabled is false and resolves the exposure alias", () => {
    expect(view("a", { command: "x", enabled: false, exposure: "codemode-deferred" })).toMatchObject({
      enabled: false,
      state: "disabled",
      exposure: "codemode",
    });
  });

  it("masks a command that carries a credential inside one string", () => {
    expect(view("a", { command: "npx -y server --token abc" }).target).toBe(`npx -y server --token ${MASK}`);
  });

  it("splits a command as a shell would and quotes a shown word that holds a space (MC42)", () => {
    expect(view("a", { command: `sh -c 'curl -H "X-Api-Key: abc" https://h.example/'` }).target).toBe(
      `sh -c "curl -H 'X-Api-Key: ${MASK}' https://h.example/"`,
    );
    expect(view("a", { command: "sh", args: ["-c", "npx s --token abc"] }).target).toBe(
      `sh -c 'npx s --token ${MASK}'`,
    );
  });

  it("never shows an env name that is itself a literal value", () => {
    const v = view("a", {
      command: "x",
      env: { "sk-live-abcdefghijklmnopqrstuvwxyz0123": "1", OK_NAME: "2" },
    });
    expect(v.envNames).toEqual([MASK, "OK_NAME"]);
  });
});

describe("maskMcpEntry: an HTTP server", () => {
  const raw = {
    url: "https://user:pw@mcp.example/v1?token=abc123&page=2",
    headers: { Authorization: "Bearer literal-secret-header", "X-Team": "${TEAM}", "X-Run": "!echo hi" },
    oauth: { clientId: "id-1", clientSecret: "literal-client-secret", callbackPort: 8765 },
    description: "private text",
  };

  it("masks the URL, lists header names only and never carries the oauth secret", () => {
    const v = view("docs", raw);
    expect(McpServerView.parse(v)).toEqual(v);
    expect(v).toMatchObject({
      kind: "http",
      target: `https://${MASK}@mcp.example/v1?token=${MASK}&page=2`,
      headerNames: ["Authorization", "X-Team", "X-Run"],
      commandFields: ["headers.X-Run"],
      variables: ["TEAM"],
      oauth: false,
      state: "on",
    });
    const text = JSON.stringify(v);
    for (const value of ["literal-secret-header", "literal-client-secret", "pw@", "abc123", "private text"])
      expect(text).not.toContain(value);
  });

  it("reports oauth for a server without an Authorization header, and a command client secret by name", () => {
    expect(view("a", { url: "https://h.example/mcp" }).oauth).toBe(true);
    const v = view("a", { url: "https://h.example/mcp", oauth: { clientSecret: "!pass show x" } });
    expect(v.commandFields).toEqual(["oauth.clientSecret"]);
    expect(JSON.stringify(v)).not.toContain("pass show");
    expect(view("a", { url: "https://h.example/mcp", headers: { authorization: "x" } }).oauth).toBe(false);
  });

  it("accepts type http and streamable-http, refuses sse", () => {
    expect(view("a", { type: "streamable-http", url: "https://h.example" }).kind).toBe("http");
    expect(view("a", { type: "sse", url: "https://h.example" })).toMatchObject({
      kind: "invalid",
      state: "invalid",
    });
  });
});

describe("maskMcpEntry: overrides and invalid entries", () => {
  it("reads a project entry with only enabled, exposure and toolExposure as an override", () => {
    expect(view("x", { enabled: false }, "project")).toMatchObject({
      kind: "override",
      scope: "project",
      enabled: false,
      target: "",
      state: "disabled",
      problem: null,
    });
    expect(view("x", { exposure: "hidden", toolExposure: { a: "direct" } }, "project")).toMatchObject({
      kind: "override",
      exposure: "hidden",
      toolExposureCount: 1,
    });
  });

  it("makes an override with any other key invalid", () => {
    expect(view("x", { enabled: false, env: { A: "1" } }, "project")).toMatchObject({
      kind: "invalid",
      problem: "override-fields",
    });
    expect(view("x", { description: "d" }, "project").kind).toBe("invalid");
  });

  it("refuses auth.provider in a project file and accepts it in the global one", () => {
    const entry = { url: "https://h.example/mcp", auth: { provider: "anthropic" } };
    expect(view("x", entry, "project")).toMatchObject({ kind: "invalid", problem: "auth-in-project" });
    expect(view("x", entry, "global")).toMatchObject({ kind: "http", problem: null });
  });

  it("answers a fixed phrase for each shape error and never quotes the entry", () => {
    const cases: Array<[string, unknown, string]> = [
      ["not-an-object", "sk-secret-in-a-string", "invalid-shape"],
      ["no-transport", { description: "d", timeout: 5 }, "no-transport"],
      ["bad-args", { command: "x", args: ["a", 5] }, "invalid-shape"],
      ["bad-env", { command: "x", env: { A: 5 } }, "invalid-shape"],
      [
        "bad-headers",
        { url: "https://h.example", headers: { A: { b: "sk-nested-secret" } } },
        "invalid-shape",
      ],
      ["bad-url", { url: "ftp://h.example" }, "bad-url"],
      ["bad-exposure", { command: "x", exposure: "everywhere" }, "invalid-shape"],
      ["bad-timeout", { command: "x", timeout: -1 }, "invalid-shape"],
      ["bad-enabled", { command: "x", enabled: "no" }, "invalid-shape"],
    ];
    for (const [label, raw, problem] of cases) {
      const v = view("a", raw);
      expect([label, v.kind, v.problem]).toEqual([label, "invalid", problem]);
      expect(JSON.stringify(v)).not.toMatch(/sk-secret|sk-nested/);
    }
  });

  it("makes a name Pi would refuse invalid, without any prototype effect", () => {
    for (const name of ["__proto__", "constructor", "a b", "a.b", "-x", "a/b", "x".repeat(65), ""]) {
      const v = view(name || "empty", { command: "x" });
      const named = maskMcpEntry(name, { command: "x" }, "global");
      expect([name, named.kind, named.problem]).toEqual([name, "invalid", "invalid-name"]);
      expect(v.name.length).toBeLessThanOrEqual(64);
    }
    expect(({} as { enabled?: unknown }).enabled).toBeUndefined();
  });

  it("shows a valid name as it is, however long and mixed", () => {
    expect(view("github-mcp-server-v2-2024", { command: "x" }).name).toBe("github-mcp-server-v2-2024");
  });

  it("clips a long invalid name so the view stays valid", () => {
    const v = view("x".repeat(500), { command: "x" });
    expect(McpServerView.safeParse(v).success).toBe(true);
  });
});

describe("McpEntry", () => {
  it("keeps fields it does not know (passthrough) and holds no prototype pollution from a nested __proto__", () => {
    const raw = JSON.parse('{"command":"x","future":{"a":1},"env":{"__proto__":"polluted"}}') as unknown;
    const parsed = McpEntry.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect((parsed.data as Record<string, unknown>).future).toEqual({ a: 1 });
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(({} as { a?: unknown }).a).toBeUndefined();
  });
});
