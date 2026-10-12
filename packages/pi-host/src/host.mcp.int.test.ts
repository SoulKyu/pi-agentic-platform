import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type ExtensionAPI,
  type ExtensionFactory,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { InitRecord } from "@pap/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApprovals } from "./approvals.ts";
import { closeSession } from "./shutdown.ts";
import { openSession } from "./open-session.ts";
import { CODEMODE_SOURCE, MCP_SOURCE, TOOL_SEARCH_SOURCE } from "./policy/tool-kind.ts";
import { writeMcpFixture } from "./testing/mcp-fixture.ts";
import { RULES } from "./testing/host-bed.ts";
import { NO_SECRETS } from "./testing/pipeline-bed.ts";
import { blockedAttempts } from "./testing/network-guard.ts";
import { createUiBridge } from "./ui-bridge.ts";

// The one thing the plan leaves to implementation (M5R24): the source path Pi records for the tools of its
// MCP, codemode and tool-search extensions. openSession runs in this process with the three built-in factories
// the CLI loads (SDK sessions do not), against the stdio fixture; pi-host's own worker does not load them yet.
let root: string;
let session: AgentSession | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-mcp-")));
  for (const dir of ["agent", "project", "home", "pap"]) mkdirSync(join(root, dir));
  writeFileSync(join(root, "script.json"), JSON.stringify({ steps: [{ text: "hi" }] }));
  vi.stubEnv("HOME", join(root, "home"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("PI_TELEMETRY", "0");
  vi.stubEnv("PAP_TEST_PROVIDER", "1");
});
afterEach(async () => {
  // session_shutdown stops the MCP server child; dispose alone would leave the fixture running.
  if (session) await closeSession(session, 5_000);
  session?.dispose();
  session = undefined;
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  expect(blockedAttempts).toEqual([]);
});

// A bare factory is `<inline:N>`; Pi names its own extensions `builtin:<name>` (`InlineExtension.builtin`), which is what the policy trusts.
const builtin = (name: string, factory: ExtensionFactory): InlineExtension => ({
  name,
  factory,
  builtin: true,
  replaceable: true,
});

interface ToolSeen {
  name: string;
  path: string;
  annotations?: { readOnlyHint?: boolean | undefined } | undefined;
}

it("records the source path Pi gives MCP, codemode and tool_search tools (M5R24 probe)", async () => {
  const agentDir = join(root, "agent");
  writeMcpFixture(agentDir, {
    tools: [
      { name: "lookup", annotations: { readOnlyHint: true }, reply: "ok" },
      { name: "write", reply: "done" },
    ],
  });
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultTools: ["+codemode", "+tool_search"] }),
  );
  const init: InitRecord = {
    type: "init",
    cwd: join(root, "project"),
    agentDir,
    papHome: join(root, "pap"),
    umask: 0o022,
    policy: RULES,
    testProviderScript: join(root, "script.json"),
  };
  let api: ExtensionAPI | undefined;
  session = await openSession(init, {
    ui: createUiBridge(() => true),
    approvals: createApprovals(() => true),
    rules: () => RULES,
    rulesVersion: () => 0,
    audit: () => {},
    secrets: NO_SECRETS,
    onEvent: () => {},
    onExtensionError: () => {},
    extraExtensions: [
      builtin("codemode", createCodemodeExtension()),
      builtin("tool-search", createToolSearchExtension()),
      builtin("mcp", createMcpExtension()),
      { name: "tools-probe", factory: (pi) => void (api = pi) },
    ],
  });
  const tools = (): Map<string, ToolSeen> =>
    new Map(
      (api?.getAllTools() ?? []).map((tool) => [
        tool.name,
        { name: tool.name, path: tool.sourceInfo.path, annotations: tool.annotations },
      ]),
    );
  // The servers connect in the background once the session starts: MCP tools appear when theirs has.
  await vi.waitFor(() => expect(tools().has("mcp__fix__lookup")).toBe(true), {
    timeout: 20_000,
    interval: 50,
  });
  const seen = tools();
  expect(seen.get("mcp__fix__lookup")).toMatchObject({
    path: MCP_SOURCE,
    annotations: { readOnlyHint: true },
  });
  expect(seen.get("mcp__fix__write")).toMatchObject({ path: MCP_SOURCE });
  expect(seen.get("mcp__fix__write")?.annotations?.readOnlyHint).toBeUndefined();
  expect(seen.get("read_mcp_resource")).toMatchObject({ path: MCP_SOURCE });
  expect(seen.get("codemode")).toMatchObject({ path: CODEMODE_SOURCE });
  expect(seen.get("tool_search")).toMatchObject({ path: TOOL_SEARCH_SOURCE });
});
