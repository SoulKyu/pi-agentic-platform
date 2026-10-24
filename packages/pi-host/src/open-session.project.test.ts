import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentSession, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { OKF_INDEX_TEXT, PolicyRules } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApprovals } from "./approvals.ts";
import { openSession } from "./open-session.ts";
import { closeSession } from "./shutdown.ts";
import { createHostBed } from "./testing/host-bed.ts";
import { idleTaint, NO_SECRETS } from "./testing/pipeline-bed.ts";
import { makeVmWorld } from "./testing/vm-world.ts";
import { createUiBridge } from "./ui-bridge.ts";

let bed: ReturnType<typeof createHostBed>;
let world: ReturnType<typeof makeVmWorld>;
let session: AgentSession | undefined;
let project: string;

beforeEach(() => {
  bed = createHostBed();
  world = makeVmWorld({ piAgentDir: bed.agentDir, project: true });
  project = world.layout.project as string;
  vi.stubEnv("HOME", join(world.base, "home"));
  vi.stubEnv("PI_CODING_AGENT_DIR", bed.agentDir);
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("PI_TELEMETRY", "0");
  vi.stubEnv("PAP_TEST_PROVIDER", "1");
  mkdirSync(join(world.base, "home"));
  writeFileSync(join(world.base, "script.json"), JSON.stringify({ steps: [{ text: "done" }] }));
});
afterEach(async () => {
  if (session) await closeSession(session, 5_000);
  session?.dispose();
  session = undefined;
  await bed.dispose();
  world.cleanup();
  vi.unstubAllEnvs();
});

async function open(): Promise<AgentSession> {
  const rules = PolicyRules.parse({
    profile: "project",
    approvalMode: "supervised",
    agentHome: project,
    agentScratch: null,
    sandbox: { required: true, network: true },
  });
  session = await openSession(
    {
      type: "init",
      cwd: project,
      agentDir: bed.agentDir,
      papHome: bed.papHome,
      umask: 0o022,
      policy: rules,
      testProviderScript: join(world.base, "script.json"),
      knowledge: { path: world.layout.knowledge },
      vm: {
        layout: world.layout,
        bwrap: "/nonexistent/bwrap",
        relayKey: "ab".repeat(32),
        slot: "0123456789abcdef0123456789abcdef",
        rootView: "read-only",
      },
    } as never,
    {
      ui: createUiBridge(() => true),
      approvals: createApprovals(() => true),
      rules: () => rules,
      rulesVersion: () => 0,
      taint: idleTaint(),
      audit: () => {},
      secrets: NO_SECRETS,
      onEvent: () => {},
      onExtensionError: () => {},
    },
  );
  return session;
}

describe("a project session", () => {
  it("adds the OKF section only when the project's index passes", async () => {
    const knowledge = world.layout.knowledge;
    expect((await open()).systemPrompt).not.toContain("Durable knowledge (OKF)");
    session?.dispose();
    mkdirSync(knowledge, { recursive: true });
    writeFileSync(join(knowledge, "index.md"), "# no version here\n");
    expect((await open()).systemPrompt).not.toContain("Durable knowledge (OKF)");
    session?.dispose();
    writeFileSync(join(knowledge, "index.md"), OKF_INDEX_TEXT);
    expect((await open()).systemPrompt).toContain(
      `Durable knowledge (OKF) is kept in the folder ${knowledge}.`,
    );
  });

  it("refuses an index.md that is a link", async () => {
    const knowledge = world.layout.knowledge;
    mkdirSync(knowledge, { recursive: true });
    writeFileSync(join(world.base, "elsewhere.md"), OKF_INDEX_TEXT);
    symlinkSync(join(world.base, "elsewhere.md"), join(knowledge, "index.md"));
    expect((await open()).systemPrompt).not.toContain("Durable knowledge (OKF)");
  });

  it("a project session loads AGENTS.md and no repository extension or skill", async () => {
    writeFileSync(join(project, "AGENTS.md"), "Repository rule: use tabs.\n");
    mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
    mkdirSync(join(project, ".pi", "skills", "probe"), { recursive: true });
    const extension = join(project, ".pi", "extensions", "probe.js");
    writeFileSync(extension, "export default function () {}\n");
    writeFileSync(
      join(project, ".pi", "skills", "probe", "SKILL.md"),
      "---\nname: probe\ndescription: A probe skill.\n---\nbody\n",
    );
    // Even a stored trust decision for the folder does not open its `.pi/` resources.
    new ProjectTrustStore(bed.agentDir).set(project, true);
    const opened = await open();
    expect(opened.systemPrompt).toContain("Repository rule: use tabs.");
    expect(opened.systemPrompt).not.toContain("a long-term agent of this pap instance");
    expect(opened.extensionRunner.getExtensionPaths()).not.toContain(extension);
    expect(opened.resourceLoader.getSkills().skills.map((skill) => skill.name)).not.toContain("probe");
  });
});
