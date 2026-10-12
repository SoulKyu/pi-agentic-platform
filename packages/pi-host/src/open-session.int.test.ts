import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type InlineExtension,
  ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import { type InitRecord, POLICY_EXTENSION_PATH, type PolicyAuditEntry } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ApprovalOutbound, createApprovals } from "./approvals.ts";
import { type ExtensionErrorReport, openSession, type OpenSessionDeps } from "./open-session.ts";
import { POLICY_EXTENSION_NAME } from "./policy/extension.ts";
import { RULES } from "./testing/host-bed.ts";
import { NO_SECRETS } from "./testing/pipeline-bed.ts";
import { blockedAttempts } from "./testing/network-guard.ts";
import { createUiBridge, type UiOutbound } from "./ui-bridge.ts";

// openSession runs in this process: HOME, the agent directory and the data directory are temporary, Pi is offline
// and the network guard above turns any socket into a failure.
let root: string;
let agentDir: string;
let cwd: string;
let marker: string;
let opened: AgentSession[];
let requests: Array<UiOutbound | ApprovalOutbound>;
let reports: ExtensionErrorReport[];
let audits: PolicyAuditEntry[];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-open-")));
  agentDir = join(root, "agent");
  cwd = join(root, "project");
  marker = join(root, "extension-ran");
  for (const dir of [agentDir, cwd, join(root, "home"), join(root, "pap")]) mkdirSync(dir);
  writeFileSync(join(root, "script.json"), JSON.stringify({ steps: [{ text: "hi" }] }));
  vi.stubEnv("HOME", join(root, "home"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("PI_TELEMETRY", "0");
  vi.stubEnv("PAP_TEST_PROVIDER", "1");
  opened = [];
  requests = [];
  reports = [];
  audits = [];
});
afterEach(() => {
  for (const session of opened) session.dispose();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  // The code that tried to connect may have swallowed the refusal; the guard's own record cannot be (R94).
  expect(blockedAttempts).toEqual([]);
});

const initRecord = (): InitRecord => ({
  type: "init",
  cwd,
  agentDir,
  papHome: join(root, "pap"),
  umask: 0o022,
  policy: RULES,
  testProviderScript: join(root, "script.json"),
});

async function open(overrides: Partial<OpenSessionDeps> = {}) {
  const ui = createUiBridge((record) => (requests.push(record), true));
  const approvals = createApprovals((record) => (requests.push(record), true));
  const session = await openSession(initRecord(), {
    ui,
    approvals,
    rules: () => RULES,
    rulesVersion: () => 0,
    audit: (entry) => audits.push(entry),
    secrets: NO_SECRETS,
    onEvent: () => {},
    onExtensionError: (report) => reports.push(report),
    ...overrides,
  });
  opened.push(session);
  return { session, ui, approvals };
}

const paths = (session: AgentSession) => session.extensionRunner.getExtensionPaths();

function addProjectExtension(): string {
  const dir = join(cwd, ".pi", "extensions");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "probe.js");
  writeFileSync(
    file,
    `import { appendFileSync } from "node:fs";\nexport default function () { appendFileSync(${JSON.stringify(marker)}, "ran\\n"); }\n`,
  );
  return file;
}
const trust = (decision: boolean) => new ProjectTrustStore(agentDir).set(cwd, decision);
const ran = () => existsSync(marker);

describe("project trust fails closed", () => {
  it("does not run a project extension when no decision is stored", async () => {
    const file = addProjectExtension();
    const { session } = await open();
    expect(ran()).toBe(false);
    expect(paths(session)).not.toContain(file);
    expect(reports).toEqual([]);
  });

  it("does not run a project extension of a distrusted project", async () => {
    addProjectExtension();
    trust(false);
    await open();
    expect(ran()).toBe(false);
  });

  it("runs the project extension once the project is trusted", async () => {
    const file = addProjectExtension();
    trust(true);
    const { session } = await open();
    expect(ran()).toBe(true);
    expect(paths(session)).toContain(file);
  });

  it("does not load an extension that appears after the session opened, when reloaded", async () => {
    const { session } = await open();
    const file = addProjectExtension();
    await session.reload();
    expect(ran()).toBe(false);
    expect(paths(session)).not.toContain(file);
  });

  it.each([
    [
      "a corrupt trust file",
      () => writeFileSync(join(agentDir, "trust.json"), "{not json"),
      "Failed to read trust store",
    ],
    [
      "a trust file of the wrong shape",
      () => writeFileSync(join(agentDir, "trust.json"), "[]"),
      "Invalid trust store",
    ],
    [
      "a trust store another process holds",
      () => mkdirSync(join(agentDir, "trust.json.lock")),
      "already being held",
    ],
  ])("treats %s as untrusted, opens the session and reports it once", async (_name, break_, message) => {
    const file = addProjectExtension();
    break_();
    const { session } = await open();
    expect(ran()).toBe(false);
    expect(paths(session)).not.toContain(file);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ extensionPath: "<pap:project-trust>", event: "project_trust" });
    expect(reports[0]?.error).toContain(message);
  });
});

describe("pap-policy stays the last extension", () => {
  const rewriter: InlineExtension = {
    name: "rewriter",
    factory: (pi) => {
      pi.on("tool_call", (event) => {
        if (event.toolName === "bash") (event.input as { command: string }).command += " # rewritten";
      });
    },
  };

  it("is last when it is the only inline extension", async () => {
    const { session } = await open();
    expect(paths(session).at(-1)).toBe(POLICY_EXTENSION_PATH);
  });

  it("is last after reload()", async () => {
    const { session } = await open({ extraExtensions: [rewriter] });
    await session.reload();
    await session.reload();
    expect(paths(session)).toEqual(["<inline:rewriter>", POLICY_EXTENSION_PATH]);
  });

  it("is last when the project is trusted, before and after a reload", async () => {
    const file = addProjectExtension();
    trust(true);
    const { session } = await open({ extraExtensions: [rewriter] });
    expect(paths(session).at(-1)).toBe(POLICY_EXTENSION_PATH);
    expect(paths(session)).toContain(file);
    await session.reload();
    expect(paths(session).at(-1)).toBe(POLICY_EXTENSION_PATH);
    expect(paths(session)).toContain(file);
  });

  it("is last when Pi's built-in extensions are loaded", async () => {
    const builtins = [createCodemodeExtension(), createToolSearchExtension(), createMcpExtension()];
    const { session } = await open({ extraExtensions: [...builtins, rewriter] });
    expect(paths(session)).toHaveLength(builtins.length + 2);
    expect(paths(session).at(-1)).toBe(POLICY_EXTENSION_PATH);
    await session.reload();
    expect(paths(session).at(-1)).toBe(POLICY_EXTENSION_PATH);
  });

  it("judges the input an earlier extension rewrote, not the one the model sent", async () => {
    const { session, approvals } = await open({ extraExtensions: [rewriter] });
    const result = session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolCallId: "c1",
      toolName: "bash",
      input: { command: "echo safe" },
    });
    await vi.waitFor(() => expect(requests.filter((r) => r.type === "approval_request")).toHaveLength(1), {
      timeout: 5000,
      interval: 20,
    });
    const ask = requests[0] as Extract<ApprovalOutbound, { type: "approval_request" }>;
    expect(ask.message).toContain("echo safe # rewritten");
    approvals.resolve({ id: ask.id, answer: "deny" });
    expect(await result).toEqual({ block: true, reason: "Denied by the user." });
    expect(audits).toMatchObject([{ toolCallId: "c1", tool: "bash", category: "exec", decision: "denied" }]);
  });
});

describe("a session never starts without pap-policy", () => {
  it("rejects when the policy extension fails to load", async () => {
    const failing = (): InlineExtension => ({
      name: POLICY_EXTENSION_NAME,
      factory: () => {
        throw new Error("policy exploded");
      },
    });
    await expect(open({ createPolicy: failing as never })).rejects.toThrow("pap-policy is not loaded");
    expect(opened).toEqual([]);
  });

  it("rejects when the policy extension is not the one Pi is told to look for", async () => {
    const renamed = () => ({ name: "something-else", factory: () => {} });
    await expect(open({ createPolicy: renamed as never })).rejects.toThrow("pap-policy is not loaded");
  });

  it("rejects a test provider script unless the worker environment allows one", async () => {
    vi.stubEnv("PAP_TEST_PROVIDER", "");
    await expect(open()).rejects.toThrow("PAP_TEST_PROVIDER=1");
    vi.stubEnv("PAP_TEST_PROVIDER", "yes");
    await expect(open()).rejects.toThrow("PAP_TEST_PROVIDER=1");
  });

  it("rejects when the environment names another agent directory", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "elsewhere"));
    await expect(open()).rejects.toThrow("PI_CODING_AGENT_DIR must name the agent directory");
    vi.stubEnv("PI_CODING_AGENT_DIR", "");
    await expect(open()).rejects.toThrow("PI_CODING_AGENT_DIR must name the agent directory");
  });
});
