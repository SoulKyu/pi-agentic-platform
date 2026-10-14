import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSession, type ExtensionAPI, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { type InitRecord, NO_TAINT } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApprovals } from "./approvals.ts";
import { openSession } from "./open-session.ts";
import { classifyTool, CODEMODE_SOURCE, MCP_SOURCE, TOOL_SEARCH_SOURCE } from "./policy/tool-kind.ts";
import { createTaint } from "./policy/taint.ts";
import { closeSession } from "./shutdown.ts";
import { mcpFixtureFiles, writeMcpFixture } from "./testing/mcp-fixture.ts";
import { RULES } from "./testing/host-bed.ts";
import { blockedAttempts } from "./testing/network-guard.ts";
import { NO_SECRETS } from "./testing/pipeline-bed.ts";
import { createUiBridge, type UiOutbound } from "./ui-bridge.ts";

// The M5R24 probe again, now through openSession's own factory list: nothing but the probe is passed in.
let root: string;
let session: AgentSession | undefined;
let api: ExtensionAPI | undefined;
let outbound: UiOutbound[];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-builtins-")));
  for (const dir of ["agent", "project", "home", "pap"]) mkdirSync(join(root, dir));
  outbound = [];
  api = undefined;
  vi.stubEnv("HOME", join(root, "home"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("PI_TELEMETRY", "0");
  vi.stubEnv("PAP_TEST_PROVIDER", "1");
});
afterEach(async () => {
  if (session) await closeSession(session, 5_000);
  session?.dispose();
  session = undefined;
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  expect(blockedAttempts).toEqual([]);
});

async function open(steps: object[], options: { fixture?: boolean; settings?: object } = {}) {
  const agentDir = join(root, "agent");
  if (options.fixture)
    writeMcpFixture(agentDir, {
      tools: [{ name: "lookup", annotations: { readOnlyHint: true }, reply: "ok" }],
    });
  if (options.settings) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(options.settings));
  writeFileSync(join(root, "script.json"), JSON.stringify({ steps }));
  const init: InitRecord = {
    type: "init",
    cwd: join(root, "project"),
    agentDir,
    papHome: join(root, "pap"),
    umask: 0o022,
    policy: RULES,
    testProviderScript: join(root, "script.json"),
  };
  const approvals = createApprovals((record) => {
    if (record.type === "approval_request")
      queueMicrotask(() => approvals.resolve({ id: record.id, answer: "once" }));
    return true;
  });
  session = await openSession(init, {
    ui: createUiBridge((record) => (outbound.push(record), true)),
    approvals,
    rules: () => RULES,
    rulesVersion: () => 0,
    taint: createTaint(NO_TAINT, () => {}),
    audit: () => {},
    secrets: NO_SECRETS,
    onEvent: () => {},
    onExtensionError: () => {},
    extraExtensions: [{ name: "tools-probe", factory: (pi) => void (api = pi) }],
  });
  return session;
}
const sourceOf = (name: string) => api?.getAllTools().find((tool) => tool.name === name)?.sourceInfo.path;

it("records builtin:mcp, builtin:codemode and builtin:tool-search for the tools of the production list", async () => {
  await open([{ text: "hi" }], { fixture: true });
  await vi.waitFor(() => expect(sourceOf("mcp__fix__lookup")).toBeDefined(), {
    timeout: 20_000,
    interval: 50,
  });
  expect(sourceOf("mcp__fix__lookup")).toBe(MCP_SOURCE);
  expect(sourceOf("read_mcp_resource")).toBe(MCP_SOURCE);
  expect(sourceOf("codemode")).toBe(CODEMODE_SOURCE);
  expect(sourceOf("tool_search")).toBe(TOOL_SEARCH_SOURCE);
  expect(classifyTool("mcp__fix__lookup", { path: sourceOf("mcp__fix__lookup") ?? "" })).toMatchObject({
    mcp: true,
    external: true,
    category: "external-write",
  });
}, 60_000);

it("lists /mcp among the commands", async () => {
  const opened = await open([{ text: "hi" }]);
  expect(opened.extensionRunner.getCommand("mcp")).toBeDefined();
});

it("runs codemode without a models namespace (M7R29, owner m11)", async () => {
  const opened = await open(
    [
      { toolCalls: [{ name: "codemode", args: { code: "return typeof models;" }, id: "cm1" }] },
      { text: "done" },
    ],
    { settings: { defaultTools: ["+codemode"] } },
  );
  await opened.prompt("go");
  const results = readFileSync(opened.sessionFile ?? "", "utf8")
    .split("\n")
    .filter((line) => line.includes('"role":"toolResult"'))
    .map((line) => JSON.parse(line).message as { toolName: string; isError: boolean; content: unknown });
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ toolName: "codemode", isError: false });
  expect(JSON.stringify(results[0]?.content)).toContain("undefined");
  expect(JSON.stringify(results[0]?.content)).not.toContain("object");
}, 60_000);

it("lets an extension that registers /mcp replace the built-in, whose tools then classify as unknown", async () => {
  new ProjectTrustStore(join(root, "agent")).set(join(root, "project"), true);
  const dir = join(root, "project", ".pi", "extensions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "own-mcp.js"),
    `export default function (pi) {
  pi.registerCommand("mcp", { handler: async () => {} });
  pi.registerTool({ name: "mcp__own__tool", label: "t", description: "t", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "x" }], details: {} }) });
}
`,
  );
  const opened = await open([{ text: "hi" }]);
  const paths = opened.extensionRunner.getExtensionPaths();
  expect(paths.some((path) => path.endsWith("own-mcp.js"))).toBe(true);
  expect(paths).not.toContain(MCP_SOURCE);
  const path = sourceOf("mcp__own__tool") ?? "";
  expect(path).toMatch(/own-mcp\.js$/);
  expect(classifyTool("mcp__own__tool", { path })).toMatchObject({
    category: "unknown",
    mcp: false,
    external: true,
  });
});

const toolResults = (opened: AgentSession) =>
  readFileSync(opened.sessionFile ?? "", "utf8")
    .split("\n")
    .filter((line) => line.includes('"role":"toolResult"'))
    .map((line) => JSON.parse(line).message as { toolCallId: string; content: Array<{ text: string }> });
const script = (id: string, code: string) => ({ toolCalls: [{ name: "codemode", args: { code }, id }] });

// Review I1: store() keeps an MCP result and load() returns it later with no nested external call to mark the parent.
it("fences a later codemode load() of a stored MCP result in a tainted session", async () => {
  const opened = await open(
    [
      script(
        "cm1",
        'const r = await tools.mcp__fix__lookup({ q: "a" }); store("k", r); text("stored " + JSON.stringify(r));',
      ),
      script("cm2", 'text("loaded " + JSON.stringify(load("k")));'),
      { text: "done" },
    ],
    { fixture: true, settings: { defaultTools: ["+codemode"] } },
  );
  await vi.waitFor(() => expect(sourceOf("mcp__fix__lookup")).toBeDefined(), {
    timeout: 20_000,
    interval: 50,
  });
  await opened.prompt("go");
  const byId = new Map(
    toolResults(opened).map((result) => [
      result.toolCallId,
      result.content.map((part) => part.text).join("\n"),
    ]),
  );
  expect(byId.get("cm1")).toMatch(/^<untrusted source="codemode"/);
  expect(byId.get("cm2")).toMatch(/^<untrusted source="codemode"/);
  expect(byId.get("cm2")).toMatch(/loaded .*ok/s);
}, 60_000);

// Review I3: Pi reads `<cwd>/.pi/mcp.json` only for a trusted project, and decides that from pap's SettingsManager.
describe("a project's .pi/mcp.json", () => {
  const marker = () => join(root, "project-server-started");
  function writeProjectConfig() {
    mkdirSync(join(root, "project", ".pi"), { recursive: true });
    const fixture = JSON.parse(mcpFixtureFiles([{ name: "pp", reply: "p" }])["mcp.json"] ?? "{}") as {
      mcpServers: { fix: object };
    };
    writeFileSync(
      join(root, "project", ".pi", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          proj: fixture.mcpServers.fix,
          mark: {
            command: process.execPath,
            args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker())}, "started")`],
          },
        },
      }),
    );
  }

  it("never starts a server of an untrusted project", async () => {
    writeProjectConfig();
    await open([{ text: "hi" }], { fixture: true });
    await vi.waitFor(() => expect(sourceOf("mcp__fix__lookup")).toBeDefined(), {
      timeout: 20_000,
      interval: 50,
    });
    expect(sourceOf("mcp__proj__pp")).toBeUndefined();
    expect(existsSync(marker())).toBe(false);
  }, 60_000);

  it("starts the servers of a trusted project", async () => {
    writeProjectConfig();
    new ProjectTrustStore(join(root, "agent")).set(join(root, "project"), true);
    await open([{ text: "hi" }], { fixture: true });
    await vi.waitFor(() => expect(sourceOf("mcp__proj__pp")).toBe(MCP_SOURCE), {
      timeout: 20_000,
      interval: 50,
    });
    await vi.waitFor(() => expect(existsSync(marker())).toBe(true), { timeout: 20_000, interval: 50 });
  }, 60_000);
});
