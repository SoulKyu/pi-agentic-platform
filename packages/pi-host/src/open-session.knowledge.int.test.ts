import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { InitRecord } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApprovals } from "./approvals.ts";
import { openSession } from "./open-session.ts";
import { RULES } from "./testing/host-bed.ts";
import { idleTaint, NO_SECRETS } from "./testing/pipeline-bed.ts";
import { createUiBridge } from "./ui-bridge.ts";

let root: string;
let opened: AgentSession[];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-open-okf-")));
  for (const dir of ["agent", "project", "home", "pap"]) mkdirSync(join(root, dir));
  writeFileSync(join(root, "script.json"), JSON.stringify({ steps: [{ text: "hi" }] }));
  vi.stubEnv("HOME", join(root, "home"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("PI_TELEMETRY", "0");
  vi.stubEnv("PAP_TEST_PROVIDER", "1");
  opened = [];
});
afterEach(() => {
  for (const session of opened) session.dispose();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function open(
  extra: Partial<InitRecord>,
  onExtensionError: (report: { event: string }) => void = () => {},
) {
  const session = await openSession(
    {
      type: "init",
      cwd: join(root, "project"),
      agentDir: join(root, "agent"),
      papHome: join(root, "pap"),
      umask: 0o022,
      policy: RULES,
      testProviderScript: join(root, "script.json"),
      ...extra,
    },
    {
      ui: createUiBridge(() => true),
      approvals: createApprovals(() => true),
      rules: () => RULES,
      rulesVersion: () => 0,
      taint: idleTaint(),
      audit: () => {},
      secrets: NO_SECRETS,
      onEvent: () => {},
      onExtensionError,
    },
  );
  opened.push(session);
  return session;
}

const promptOf = async (extra: Partial<InitRecord>): Promise<string> => (await open(extra)).systemPrompt;

describe("the knowledge section in a session's system prompt", () => {
  it("is appended for a plain session whose init names a knowledge folder", async () => {
    const path = join(root, "project", "knowledge");
    const prompt = await promptOf({ knowledge: { path } });
    expect(prompt).toContain(`${path}/index.md`);
    expect(prompt).toContain("Never store secrets.");
  });

  it("is absent without init.knowledge", async () => {
    expect(await promptOf({})).not.toContain("OKF");
  });
});

describe("pi-mem0 in a pap session", () => {
  const probe = (name: string) =>
    `export default function (pi) { pi.registerTool({ name: "${name}", label: "${name}", description: "x", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) }); }\n`;

  it("is not loaded, while the other extensions of the agent folder still are", async () => {
    for (const [dir, tool] of [
      ["pi-mem0", "mem0_probe"],
      ["pi-other", "other_probe"],
    ] as const) {
      mkdirSync(join(root, "agent", "extensions", dir), { recursive: true });
      writeFileSync(join(root, "agent", "extensions", dir, "index.js"), probe(tool));
    }
    const reports: string[] = [];
    const session = await open({}, (report) => reports.push(report.event));
    const names = session.getAllTools().map((tool) => tool.name);
    expect(names).toContain("other_probe");
    expect(names).not.toContain("mem0_probe");
    expect(reports.filter((event) => event === "extension_skipped")).toHaveLength(1);
  });
});
