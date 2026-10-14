import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSession, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { type InitRecord, type ToolPreset } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApprovals } from "./approvals.ts";
import { openSession } from "./open-session.ts";
import { RULES } from "./testing/host-bed.ts";
import { blockedAttempts } from "./testing/network-guard.ts";
import { idleTaint, NO_SECRETS } from "./testing/pipeline-bed.ts";
import { createUiBridge } from "./ui-bridge.ts";

// Chat only (M7R74): a trusted project's extensions and an installed package's extensions do not load either.
let root: string;
let opened: AgentSession | undefined;
const marker = (name: string) => join(root, `${name}-ran`);
const source = (name: string) =>
  `import { writeFileSync } from "node:fs";\nexport default function () { writeFileSync(${JSON.stringify(marker(name))}, "ran"); }\n`;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-chat-")));
  for (const dir of ["agent", "project", "home", "pap", "pkg"]) mkdirSync(join(root, dir));
  writeFileSync(join(root, "script.json"), JSON.stringify({ steps: [{ text: "hi" }] }));
  vi.stubEnv("HOME", join(root, "home"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("PI_TELEMETRY", "0");
  vi.stubEnv("PAP_TEST_PROVIDER", "1");
  // A trusted project with an extension of its own.
  mkdirSync(join(root, "project", ".pi", "extensions"), { recursive: true });
  writeFileSync(join(root, "project", ".pi", "extensions", "probe.js"), source("project"));
  new ProjectTrustStore(join(root, "agent")).set(join(root, "project"), true);
  // An installed package (a local path in settings.json) with an extension.
  writeFileSync(join(root, "pkg", "ext.js"), source("package"));
  writeFileSync(
    join(root, "pkg", "package.json"),
    JSON.stringify({ name: "pap-test-pkg", version: "1.0.0", pi: { extensions: ["./ext.js"] } }),
  );
  writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ packages: [join(root, "pkg")] }));
});
afterEach(() => {
  opened?.dispose();
  opened = undefined;
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  expect(blockedAttempts).toEqual([]);
});

async function open(preset: ToolPreset) {
  const init: InitRecord = {
    type: "init",
    cwd: join(root, "project"),
    agentDir: join(root, "agent"),
    papHome: join(root, "pap"),
    umask: 0o022,
    policy: RULES,
    testProviderScript: join(root, "script.json"),
    tools: { preset },
  };
  opened = await openSession(init, {
    ui: createUiBridge(() => true),
    approvals: createApprovals(() => true),
    rules: () => RULES,
    rulesVersion: () => 0,
    taint: idleTaint(),
    audit: () => {},
    secrets: NO_SECRETS,
    onEvent: () => {},
    onExtensionError: () => {},
  });
  return opened;
}

describe("what a chat session does not load", () => {
  it("loads a trusted project's extension and an installed package's under full (the control)", async () => {
    await open("full");
    expect(existsSync(marker("project"))).toBe(true);
    expect(existsSync(marker("package"))).toBe(true);
  }, 60_000);

  it("loads neither under chat, nor after a reload", async () => {
    const session = await open("chat");
    await session.reload();
    expect(existsSync(marker("project"))).toBe(false);
    expect(existsSync(marker("package"))).toBe(false);
  }, 60_000);
});
