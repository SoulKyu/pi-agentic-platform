import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSession } from "@earendil-works/pi-coding-agent";
import { type InitRecord, NO_TAINT } from "@pap/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApprovals } from "./approvals.ts";
import { openSession } from "./open-session.ts";
import { createTaint } from "./policy/taint.ts";
import { closeSession } from "./shutdown.ts";
import { handleGetCommands } from "./slash-commands.ts";
import { RULES } from "./testing/host-bed.ts";
import { blockedAttempts } from "./testing/network-guard.ts";
import { NO_SECRETS } from "./testing/pipeline-bed.ts";
import { createUiBridge } from "./ui-bridge.ts";

// A real Pi session over temporary agent and project directories: prompt templates and skills come from Pi's own loader.
let root: string;
let session: AgentSession | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-slash-")));
  for (const dir of ["agent", "project", "home", "pap"]) mkdirSync(join(root, dir));
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

async function open() {
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "prompts"));
  writeFileSync(
    join(agentDir, "prompts", "triage.md"),
    "---\ndescription: Triage the issue\n---\nTriage $1\n",
  );
  mkdirSync(join(agentDir, "skills", "pdf-reader"), { recursive: true });
  writeFileSync(
    join(agentDir, "skills", "pdf-reader", "SKILL.md"),
    "---\nname: pdf-reader\ndescription: Reads PDF files\n---\nUse it.\n",
  );
  writeFileSync(join(root, "script.json"), JSON.stringify({ steps: [{ text: "hi" }] }));
  const init: InitRecord = {
    type: "init",
    cwd: join(root, "project"),
    agentDir,
    papHome: join(root, "pap"),
    umask: 0o022,
    policy: RULES,
    testProviderScript: join(root, "script.json"),
  };
  const approvals = createApprovals(() => true);
  session = await openSession(init, {
    ui: createUiBridge(() => true),
    approvals,
    rules: () => RULES,
    rulesVersion: () => 0,
    taint: createTaint(NO_TAINT, () => {}),
    audit: () => {},
    secrets: NO_SECRETS,
    onEvent: () => {},
    onExtensionError: () => {},
  });
  return session;
}

it("lists a prompt template, a skill and the built-in /mcp of a real session", async () => {
  const opened = await open();
  const sent: Array<Record<string, unknown>> = [];
  handleGetCommands(opened, { id: "c1" }, (record) => void sent.push(record as Record<string, unknown>));
  const data = (sent[0] as { data: { commands: Array<Record<string, unknown>> } }).data;
  expect(data.commands).toContainEqual({
    name: "triage",
    description: "Triage the issue",
    source: "prompt",
    builtinMcp: false,
  });
  expect(data.commands).toContainEqual({
    name: "skill:pdf-reader",
    description: "Reads PDF files",
    source: "skill",
    builtinMcp: false,
  });
  expect(data.commands).toContainEqual({
    name: "mcp",
    description: expect.anything(),
    source: "extension",
    builtinMcp: true,
  });
}, 60_000);
