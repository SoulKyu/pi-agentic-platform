import { describe, expect, it } from "vitest";
import { MCP_LIMITS, McpFileView, McpOverview, McpServerView, methods } from "./index.ts";

const server = {
  name: "docs",
  scope: "global",
  kind: "http",
  enabled: true,
  exposure: "codemode",
  target: "https://h.example/mcp",
  envNames: [],
  headerNames: ["Authorization"],
  commandFields: [],
  variables: ["DOCS_TOKEN"],
  oauth: false,
  toolExposureCount: 0,
  state: "on",
  lastTest: null,
  problem: null,
};
const file = { path: "/a/mcp.json", problem: null, trusted: null, servers: [server] };
const overview = {
  global: file,
  project: null,
  codemode: { autoEnable: true, source: "default" },
  settings: null,
  codemodeBuiltinOff: false,
};

describe("mcp.overview", () => {
  it("is a pi:admin query (MC38) with the error codes a caller can meet", () => {
    expect(methods["mcp.overview"]).toMatchObject({
      permission: "pi:admin",
      idempotent: true,
      errors: ["invalid_cwd", "capacity", "timeout", "helper_failed"],
    });
    expect(methods["mcp.overview"].params.safeParse({ cwd: "/w" }).success).toBe(true);
    expect(methods["mcp.overview"].params.safeParse({ cwd: "" }).success).toBe(false);
  });

  it("accepts a well-formed overview and refuses a value field in its place", () => {
    expect(McpOverview.safeParse(overview).success).toBe(true);
    expect(McpServerView.safeParse({ ...server, env: { A: "sk-1" } }).success).toBe(false);
    expect(McpServerView.safeParse({ ...server, headers: { A: "x" } }).success).toBe(false);
    expect(McpOverview.safeParse({ ...overview, extra: 1 }).success).toBe(false);
  });

  it("bounds the servers of a file at 200 and the name lists at 32", () => {
    const many = (count: number) => ({ ...file, servers: Array.from({ length: count }, () => server) });
    expect(McpFileView.safeParse(many(MCP_LIMITS.servers)).success).toBe(true);
    expect(McpFileView.safeParse(many(MCP_LIMITS.servers + 1)).success).toBe(false);
    const names = (count: number) => ({
      ...server,
      envNames: Array.from({ length: count }, (_, i) => `E${i}`),
    });
    expect(McpServerView.safeParse(names(MCP_LIMITS.names)).success).toBe(true);
    expect(McpServerView.safeParse(names(MCP_LIMITS.names + 1)).success).toBe(false);
  });

  it("knows only the listed file problems and server states", () => {
    for (const problem of [
      "unparsable",
      "invalid-shape",
      "too-many-servers",
      "too-large",
      "not-a-file",
      "link-outside",
      "link-dangling",
    ])
      expect(McpFileView.safeParse({ ...file, problem }).success).toBe(true);
    expect(McpFileView.safeParse({ ...file, problem: "other" }).success).toBe(false);
    expect(McpServerView.safeParse({ ...server, state: "weird" }).success).toBe(false);
  });
});

describe("mcp writes (Task 18)", () => {
  const writes = [
    "setEnabled",
    "setExposure",
    "setInProject",
    "remove",
    "undo",
    "add",
    "setCodemode",
  ] as const;

  it("are pi:admin mutations: a browser session only, never a token (M7R133)", () => {
    for (const name of writes)
      expect(methods[`mcp.${name}`], name).toMatchObject({ permission: "pi:admin", idempotent: false });
  });

  it("declares protected_path for the project writes and step_up_required for the global add and undo", () => {
    for (const name of ["setEnabled", "setExposure", "setInProject", "remove", "undo", "add"] as const)
      expect(methods[`mcp.${name}`].errors, name).toContain("protected_path");
    expect(methods["mcp.add"].errors).toContain("step_up_required");
    expect(methods["mcp.undo"].errors).toContain("step_up_required");
  });

  it("bounds a group switch at 200 servers and refuses an empty one", () => {
    const row = { scope: "global", name: "a" };
    const params = methods["mcp.setEnabled"].params;
    expect(params.safeParse({ servers: Array(200).fill(row), enabled: false }).success).toBe(true);
    expect(params.safeParse({ servers: Array(201).fill(row), enabled: false }).success).toBe(false);
    expect(params.safeParse({ servers: [], enabled: false }).success).toBe(false);
    expect(params.safeParse({ servers: [row], enabled: false, extra: 1 }).success).toBe(false);
  });

  it("needs a cwd for setInProject, and bounds the code mode budget at 0..1 000 000 or null", () => {
    expect(methods["mcp.setInProject"].params.safeParse({ name: "a", enabled: false }).success).toBe(false);
    const budget = methods["mcp.setCodemode"].params;
    for (const ok of [0, 1_000_000, null]) expect(budget.safeParse({ inlineBudget: ok }).success).toBe(true);
    for (const bad of [-1, 1_000_001, 1.5])
      expect(budget.safeParse({ inlineBudget: bad }).success).toBe(false);
    expect(budget.safeParse({ choice: "sometimes" }).success).toBe(false);
  });

  it("keeps the helper's removed entry text out of the method result", () => {
    expect(methods["mcp.remove"].result.safeParse({ token: "t", expiresInMs: 60_000 }).success).toBe(true);
    expect(
      methods["mcp.remove"].result.safeParse({ token: "t", expiresInMs: 60_000, entry: "{}" }).success,
    ).toBe(false);
  });
});

describe("mcp.test", () => {
  it("is a pi:admin mutation (browser session only, never a token) that declares the step-up and forbidden", () => {
    expect(methods["mcp.test"]).toMatchObject({ permission: "pi:admin", idempotent: false });
    expect(methods["mcp.test"].errors).toEqual(expect.arrayContaining(["step_up_required", "forbidden"]));
  });

  it("takes a scope, a name and an optional cwd, and nothing else", () => {
    const params = methods["mcp.test"].params;
    expect(params.safeParse({ scope: "global", name: "a" }).success).toBe(true);
    expect(params.safeParse({ scope: "project", name: "a", cwd: "/w" }).success).toBe(true);
    expect(params.safeParse({ scope: "global", name: "a", env: { K: "v" } }).success).toBe(false);
    expect(params.safeParse({ scope: "other", name: "a" }).success).toBe(false);
  });

  it("answers a state, at most 200 tool names, a message of at most 512 characters, and no other field", () => {
    const result = methods["mcp.test"].result;
    const ok = { state: "connected", tools: ["a"], toolsTruncated: false, message: null, at: 1 };
    expect(result.safeParse(ok).success).toBe(true);
    expect(result.safeParse({ ...ok, tools: Array(201).fill("a") }).success).toBe(false);
    expect(result.safeParse({ ...ok, message: "x".repeat(513) }).success).toBe(false);
    expect(result.safeParse({ ...ok, state: "exploded" }).success).toBe(false);
    expect(result.safeParse({ ...ok, stderr: "boom" }).success).toBe(false);
  });
});
