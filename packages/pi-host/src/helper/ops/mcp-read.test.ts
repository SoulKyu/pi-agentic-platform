import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { HELPER_OPS, McpOverview, MCP_LIMITS } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HelperContext } from "../ops.ts";
import { mcpOverviewOp, MCP_VIEW_BYTES_MAX, readMcpFiles } from "./mcp-read.ts";

let root: string;
let home: string;
let agentDir: string;
let cwd: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-mcp-"));
  home = join(root, "home");
  agentDir = join(home, ".pi", "agent");
  cwd = join(root, "work", "proj");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ctxFor = (withCwd = true): Pick<HelperContext, "agentDir" | "home" | "cwd"> => ({
  agentDir,
  home,
  ...(withCwd ? { cwd } : {}),
});
const servers = (value: unknown) => JSON.stringify({ mcpServers: value });
const writeGlobal = (text: string) => writeFileSync(join(agentDir, "mcp.json"), text);
const writeProject = (text: string) => writeFileSync(join(cwd, ".pi", "mcp.json"), text);
const trust = (decision: boolean) => new ProjectTrustStore(agentDir).set(cwd, decision);
const names = (view: { servers: Array<{ name: string }> } | null) => view?.servers.map((s) => s.name);

describe("readMcpFiles: the global file", () => {
  it("lists the servers with names only: no env, header or oauth value appears anywhere in the result", async () => {
    const values = [
      "sk-env-literal-1",
      "Bearer header-literal-2",
      "client-secret-literal-3",
      "arg-tok-literal-4",
    ];
    writeGlobal(
      servers({
        local: { command: "npx", args: ["--token", values[3]], env: { API_KEY: values[0] } },
        remote: {
          url: "https://h.example/mcp",
          headers: { Authorization: values[1] },
          oauth: { clientId: "c", clientSecret: values[2] },
        },
      }),
    );
    const result = await readMcpFiles(ctxFor(false));
    expect(result.global).toMatchObject({ path: join(agentDir, "mcp.json"), problem: null, trusted: null });
    expect(names(result.global)).toEqual(["local", "remote"]);
    expect(result.project).toBeNull();
    const text = JSON.stringify(result);
    for (const value of values) expect(text).not.toContain(value);
    expect(McpOverview.safeParse({ ...result }).success).toBe(true);
  });

  it("a missing file lists nothing and has no problem", async () => {
    const result = await readMcpFiles(ctxFor(false));
    expect(result.global).toMatchObject({ problem: null, servers: [] });
  });

  it("follows a dotfiles link inside the home (M7R146) and refuses one that leaves it", async () => {
    mkdirSync(join(home, "dotfiles"));
    writeFileSync(join(home, "dotfiles", "mcp.json"), servers({ viaLink: { command: "x" } }));
    symlinkSync(join(home, "dotfiles", "mcp.json"), join(agentDir, "mcp.json"));
    expect(names((await readMcpFiles(ctxFor(false))).global)).toEqual(["viaLink"]);
    rmSync(join(agentDir, "mcp.json"));
    mkdirSync(join(root, "elsewhere"));
    writeFileSync(join(root, "elsewhere", "mcp.json"), servers({ leak: { command: "x" } }));
    symlinkSync(join(root, "elsewhere", "mcp.json"), join(agentDir, "mcp.json"));
    expect((await readMcpFiles(ctxFor(false))).global).toMatchObject({
      problem: "link-outside",
      servers: [],
    });
  });

  it("reports unparsable, invalid-shape, too-large and not-a-file with no server listed", async () => {
    const problem = async () => (await readMcpFiles(ctxFor(false))).global;
    writeGlobal('{"mcpServers": {"a": ');
    expect(await problem()).toMatchObject({ problem: "unparsable", servers: [] });
    writeGlobal("﻿" + servers({}));
    expect(await problem()).toMatchObject({ problem: "unparsable" });
    writeGlobal("[]");
    expect(await problem()).toMatchObject({ problem: "invalid-shape" });
    writeGlobal('{"mcpServers": []}');
    expect(await problem()).toMatchObject({ problem: "invalid-shape" });
    writeGlobal(" ".repeat(1024 * 1024 + 1));
    expect(await problem()).toMatchObject({ problem: "too-large", servers: [] });
    rmSync(join(agentDir, "mcp.json"));
    mkdirSync(join(agentDir, "mcp.json"));
    expect(await problem()).toMatchObject({ problem: "not-a-file", servers: [] });
  });

  it("answers too-many-servers for 201 servers and lists 200", async () => {
    const many = (count: number) =>
      servers(Object.fromEntries(Array.from({ length: count }, (_, i) => [`s${i}`, { command: "x" }])));
    writeGlobal(many(MCP_LIMITS.servers + 1));
    expect((await readMcpFiles(ctxFor(false))).global).toMatchObject({
      problem: "too-many-servers",
      servers: [],
    });
    writeGlobal(many(MCP_LIMITS.servers));
    const ok = (await readMcpFiles(ctxFor(false))).global;
    expect([ok.problem, ok.servers.length]).toEqual([null, MCP_LIMITS.servers]);
  });

  it("answers too-large instead of an answer past the byte budget", async () => {
    const long = (prefix: string) =>
      Object.fromEntries(
        Array.from({ length: 32 }, (_, i) => [prefix.repeat(55) + String.fromCharCode(65 + i), "v"]),
      );
    writeGlobal(
      servers(
        Object.fromEntries(
          Array.from({ length: 200 }, (_, i) => [
            `s${i}`,
            { url: `https://h.example/${i}`, env: long("e"), headers: long("h") },
          ]),
        ),
      ),
    );
    const view = (await readMcpFiles(ctxFor(false))).global;
    expect(MCP_VIEW_BYTES_MAX).toBe(400_000);
    expect(view).toMatchObject({ problem: "too-large", servers: [] });
  });

  it("marks a name that differs only by - and _ as a collision, and the later one invalid", async () => {
    writeGlobal(servers({ "a-b": { command: "x" }, a_b: { command: "y" }, c: { command: "z" } }));
    const view = (await readMcpFiles(ctxFor(false))).global;
    expect(view.servers.map((s) => [s.name, s.state, s.problem])).toEqual([
      ["a-b", "on", null],
      ["a_b", "invalid", "name-collision"],
      ["c", "on", null],
    ]);
  });

  it("makes __proto__ and constructor invalid without any prototype pollution, and never runs a command", async () => {
    const marker = join(root, "marker");
    writeGlobal(
      `{"mcpServers": {"__proto__": {"command": "x", "enabled": false}, "constructor": {"command": "x"}, "run": {"command": "touch", "args": ["${marker}"]}}}`,
    );
    const view = (await readMcpFiles(ctxFor(false))).global;
    expect(view.servers.map((s) => [s.name, s.state, s.problem])).toEqual([
      ["__proto__", "invalid", "invalid-name"],
      ["constructor", "invalid", "invalid-name"],
      ["run", "on", null],
    ]);
    expect(({} as { enabled?: unknown }).enabled).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  });
});

describe("readMcpFiles: the project file boundary (M7R84)", () => {
  beforeEach(() => trust(true));

  it("lists a trusted project's servers", async () => {
    writeProject(servers({ tools: { command: "x" } }));
    const { project } = await readMcpFiles(ctxFor());
    expect(project).toMatchObject({ path: join(cwd, ".pi", "mcp.json"), problem: null, trusted: true });
    expect(project?.servers.map((s) => [s.name, s.scope, s.state])).toEqual([["tools", "project", "on"]]);
  });

  it("a file that is a link out of the project lists nothing", async () => {
    mkdirSync(join(root, "outside"));
    writeFileSync(join(root, "outside", "mcp.json"), servers({ leak: { command: "x" } }));
    symlinkSync(join(root, "outside", "mcp.json"), join(cwd, ".pi", "mcp.json"));
    const { project } = await readMcpFiles(ctxFor());
    expect(project).toMatchObject({ problem: "link-outside", servers: [] });
    expect(JSON.stringify(project)).not.toContain("leak");
  });

  it("a .pi folder that is a link out of the project lists nothing", async () => {
    mkdirSync(join(root, "outside"));
    writeFileSync(join(root, "outside", "mcp.json"), servers({ leak: { command: "x" } }));
    rmSync(join(cwd, ".pi"), { recursive: true });
    symlinkSync(join(root, "outside"), join(cwd, ".pi"));
    expect((await readMcpFiles(ctxFor())).project).toMatchObject({ problem: "link-outside", servers: [] });
  });

  it("a link inside the project is followed", async () => {
    writeFileSync(join(cwd, "shared.json"), servers({ inside: { command: "x" } }));
    symlinkSync(join(cwd, "shared.json"), join(cwd, ".pi", "mcp.json"));
    expect(names((await readMcpFiles(ctxFor())).project)).toEqual(["inside"]);
  });

  it("a dangling link is link-dangling", async () => {
    symlinkSync(join(root, "nowhere.json"), join(cwd, ".pi", "mcp.json"));
    expect((await readMcpFiles(ctxFor())).project).toMatchObject({ problem: "link-dangling", servers: [] });
  });

  it("a FIFO is not-a-file and does not block", async () => {
    execFileSync("mkfifo", [join(cwd, ".pi", "mcp.json")]);
    expect((await readMcpFiles(ctxFor())).project).toMatchObject({ problem: "not-a-file", servers: [] });
  });

  it("a missing project file is an empty view with the trust decision", async () => {
    expect((await readMcpFiles(ctxFor())).project).toMatchObject({
      problem: null,
      trusted: true,
      servers: [],
    });
  });
});

describe("readMcpFiles: project trust (M7R85)", () => {
  it("an untrusted project lists its servers as not-trusted and replaces nothing", async () => {
    writeGlobal(servers({ x: { command: "g" }, y: { command: "g" } }));
    writeProject(servers({ x: { command: "p" }, y: { enabled: false } }));
    for (const decision of [null, false]) {
      if (decision !== null) trust(decision);
      const { global, project } = await readMcpFiles(ctxFor());
      expect(project?.trusted).toBe(false);
      expect(project?.servers.map((s) => [s.name, s.state])).toEqual([
        ["x", "not-trusted"],
        ["y", "not-trusted"],
      ]);
      expect(global.servers.map((s) => [s.name, s.state])).toEqual([
        ["x", "on"],
        ["y", "on"],
      ]);
    }
  });

  it("a store that cannot be read means untrusted", async () => {
    writeProject(servers({ x: { command: "p" } }));
    writeFileSync(join(agentDir, "trust.json"), "{not json");
    expect((await readMcpFiles(ctxFor())).project).toMatchObject({ trusted: false });
  });

  it("a trusted project's entry replaces the global one of the same name", async () => {
    trust(true);
    writeGlobal(servers({ x: { command: "g" }, other: { command: "g" } }));
    writeProject(servers({ x: { command: "p" } }));
    const { global, project } = await readMcpFiles(ctxFor());
    expect(global.servers.map((s) => [s.name, s.state])).toEqual([
      ["x", "replaced"],
      ["other", "on"],
    ]);
    expect(project?.servers.map((s) => [s.name, s.state])).toEqual([["x", "on"]]);
  });

  it("a trusted project's override marks the global server overridden and its effective values follow", async () => {
    trust(true);
    writeGlobal(servers({ x: { command: "g", exposure: "direct" } }));
    writeProject(servers({ x: { enabled: false, exposure: "hidden" } }));
    const { global, project } = await readMcpFiles(ctxFor());
    expect(global.servers[0]).toMatchObject({
      name: "x",
      state: "overridden",
      enabled: false,
      exposure: "hidden",
    });
    expect(project?.servers[0]).toMatchObject({ name: "x", kind: "override", state: "disabled" });
  });

  it("matches an override on the raw server name: two long names with digits stay apart", async () => {
    trust(true);
    const first = "github-mcp-server-v2-2024";
    const second = "my-company-mcp-server-v2";
    const other = "another-mcp-server-v3-2025";
    writeGlobal(servers({ [first]: { command: "g" }, [second]: { command: "g" } }));
    writeProject(servers({ [other]: { enabled: false }, [second]: { command: "p" } }));
    const { global, project } = await readMcpFiles(ctxFor());
    expect(global.servers.map((s) => [s.name, s.state, s.enabled])).toEqual([
      [first, "on", true],
      [second, "replaced", true],
    ]);
    expect(project?.servers.map((s) => [s.name, s.state, s.problem])).toEqual([
      [other, "invalid", "no-base"],
      [second, "on", null],
    ]);
  });

  it("an untrusted project's name never collides with a global one", async () => {
    writeGlobal(servers({ "a-b": { command: "g" } }));
    writeProject(servers({ a_b: { command: "p" } }));
    expect((await readMcpFiles(ctxFor())).project?.servers.map((s) => [s.state, s.problem])).toEqual([
      ["not-trusted", null],
    ]);
  });

  it("an override without a global server is invalid", async () => {
    trust(true);
    writeProject(servers({ ghost: { enabled: false } }));
    expect((await readMcpFiles(ctxFor())).project?.servers[0]).toMatchObject({
      kind: "invalid",
      state: "invalid",
      problem: "no-base",
    });
  });

  it("an invalid global server is never replaced or overridden into validity", async () => {
    trust(true);
    writeGlobal(servers({ x: { description: "no transport" } }));
    writeProject(servers({ x: { enabled: false } }));
    expect((await readMcpFiles(ctxFor())).global.servers[0]).toMatchObject({ state: "invalid" });
  });

  it("a project name colliding with another project name by - and _ is invalid", async () => {
    trust(true);
    writeProject(servers({ "p-q": { command: "x" }, p_q: { command: "y" } }));
    expect((await readMcpFiles(ctxFor())).project?.servers.map((s) => [s.state, s.problem])).toEqual([
      ["on", null],
      ["invalid", "name-collision"],
    ]);
  });
});

describe("readMcpFiles: codemode", () => {
  it("defaults to automatic, follows the global file, and a trusted project's value wins", async () => {
    expect((await readMcpFiles(ctxFor())).codemode).toEqual({ autoEnable: true, source: "default" });
    writeGlobal(JSON.stringify({ autoEnableCodemode: false, mcpServers: {} }));
    expect((await readMcpFiles(ctxFor())).codemode).toEqual({ autoEnable: false, source: "global" });
    writeProject(JSON.stringify({ autoEnableCodemode: true }));
    expect((await readMcpFiles(ctxFor())).codemode).toEqual({ autoEnable: false, source: "global" });
    trust(true);
    expect((await readMcpFiles(ctxFor())).codemode).toEqual({ autoEnable: true, source: "project" });
  });

  it("ignores a value that is not a boolean", async () => {
    writeGlobal(JSON.stringify({ autoEnableCodemode: "no" }));
    expect((await readMcpFiles(ctxFor(false))).codemode).toEqual({ autoEnable: true, source: "default" });
  });
});

describe("mcp.overview helper operation", () => {
  it("is declared by the contract and answers what the contract accepts", async () => {
    writeGlobal(servers({ a: { url: "https://h.example/mcp?token=abc123" } }));
    expect(HELPER_OPS["mcp.overview"].params.safeParse({}).success).toBe(true);
    const ctx = {
      ...ctxFor(),
      papHome: root,
      signal: new AbortController().signal,
      emit: () => {},
      prompt: async () => null,
    };
    const result = HELPER_OPS["mcp.overview"].result.parse(await mcpOverviewOp.run({}, ctx));
    expect(result.global.servers[0]?.target).toBe("https://h.example/mcp?token=•••");
  });
});

describe("readMcpFiles: the code mode settings (MC44 I1)", () => {
  const writeSettings = (text: string) => writeFileSync(join(agentDir, "settings.json"), text);

  it("reports a real +codemode config and an only config from the global settings.json", async () => {
    writeSettings(
      JSON.stringify({ defaultTools: ["read", "+codemode"], codemode: { mode: "only", inlineBudget: 300 } }),
    );
    const result = await readMcpFiles(ctxFor(false));
    expect(result.settings).toEqual({ choice: "always", mode: "only", inlineBudget: 300 });
    expect(McpOverview.safeParse(result).success).toBe(true);
  });

  it("reports a disabled codemode built-in as Pi spells it, `-builtin:codemode` in `extensions` (MC46)", async () => {
    expect((await readMcpFiles(ctxFor(false))).codemodeBuiltinOff).toBe(false);
    writeSettings(JSON.stringify({ extensions: ["x.ts", "-builtin:codemode"] }));
    expect((await readMcpFiles(ctxFor(false))).codemodeBuiltinOff).toBe(true);
    writeSettings(JSON.stringify({ extensions: ["-builtin:codemode", "+builtin:codemode"] }));
    expect((await readMcpFiles(ctxFor(false))).codemodeBuiltinOff).toBe(false);
    writeSettings(JSON.stringify({ extensions: ["-builtin:mcp"] }));
    expect((await readMcpFiles(ctxFor(false))).codemodeBuiltinOff).toBe(false);
    writeSettings("{ nope");
    expect((await readMcpFiles(ctxFor(false))).codemodeBuiltinOff).toBe(false);
  });

  it("reports the defaults without a settings.json and null for one that cannot be read", async () => {
    expect((await readMcpFiles(ctxFor(false))).settings).toEqual({
      choice: "automatic",
      mode: "on",
      inlineBudget: null,
    });
    writeSettings("{ nope");
    expect((await readMcpFiles(ctxFor(false))).settings).toBeNull();
  });

  it("still lists an entry the SDK accepts but the add bounds would refuse (MC44 M4)", async () => {
    const env = Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`K${i}`, "v"]));
    writeGlobal(servers({ big: { command: "x", args: Array(300).fill("a"), env } }));
    const view = (await readMcpFiles(ctxFor(false))).global.servers[0];
    expect(view).toMatchObject({ name: "big", kind: "stdio", state: "on" });
  });
});
