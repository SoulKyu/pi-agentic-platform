import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { createHelperPool, type HelperPool } from "../../kernel/helper/pool.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { createProfileReader } from "./profile.ts";
import { createProfiles } from "./profiles.ts";

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const NETWORK_GUARD = join(REPO, "packages/pi-host/src/testing/network-guard.ts");

let root: string;
let pool: HelperPool;
let project: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-profiles-int-")));
  for (const dir of ["agent/agents", "pap", "home"]) mkdirSync(join(root, dir), { recursive: true });
  project = join(root, "work", "proj");
  mkdirSync(join(project, ".pi", "agents"), { recursive: true });
  const file = (name: string) => `---\nname: ${name}\ndescription: ${name} profile\n---\nYou are ${name}.\n`;
  writeFileSync(join(root, "agent", "agents", "scout.md"), file("scout"));
  writeFileSync(join(project, ".pi", "agents", "reviewer.md"), file("reviewer"));
  pool = createHelperPool({
    entry: join(REPO, "packages/pi-host/src/helper/main.ts"),
    execArgv: [
      "--conditions=development",
      "--disable-warning=ExperimentalWarning",
      "--import",
      NETWORK_GUARD,
    ],
    baseEnv: { PATH: process.env.PATH, LANG: process.env.LANG, HOME: join(root, "home") },
    agentDir: join(root, "agent"),
    papHome: join(root, "pap"),
    max: 2,
    clock: createSystemClock(),
    logger: silentLogger,
  });
});
afterEach(async () => {
  try {
    await pool.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const profiles = (trusted: boolean | null, agent = false) =>
  createProfiles({
    pi: { helpers: pool, trust: { status: async () => trusted } },
    sessions: { cwdOf: () => project, runsInVm: () => agent },
    logger: silentLogger,
  });

describe("subagents.profiles through a real helper", () => {
  it("lists only the user's agent files for an untrusted folder", async () => {
    const result = await profiles(false).list(testCaller(), "s1");
    expect(result.profiles).toEqual([{ name: "scout", description: "scout profile", source: "user" }]);
  });

  it("adds the project's once Pi's trust store trusts the folder", async () => {
    new ProjectTrustStore(join(root, "agent")).set(project, true);
    const result = await profiles(true).list(testCaller(), "s1");
    expect(result.profiles.map((p) => `${p.source}:${p.name}`)).toEqual(["project:reviewer", "user:scout"]);
  });

  it("reads no project profile for an agent's session under an ancestor trust (W5-R27, W5-R29)", async () => {
    new ProjectTrustStore(join(root, "agent")).set(join(root, "work"), true);
    const agentSessions = profiles(true, true);
    expect((await agentSessions.list(testCaller(), "s1")).profiles.map((p) => p.name)).toEqual(["scout"]);
    const reader = createProfileReader({
      pi: { helpers: pool, trust: { status: async () => true } },
      sessions: { cwdOf: () => project, runsInVm: () => true },
      logger: silentLogger,
    });
    await expect(reader.get("u1", "s1", "reviewer")).rejects.toMatchObject({ code: "not_found" });
    const plain = createProfileReader({
      pi: { helpers: pool, trust: { status: async () => true } },
      sessions: { cwdOf: () => project, runsInVm: () => false },
      logger: silentLogger,
    });
    expect((await plain.get("u1", "s1", "reviewer")).source).toBe("project");
    expect((await profiles(true).list(testCaller(), "s1")).profiles.map((p) => p.name)).toEqual([
      "reviewer",
      "scout",
    ]);
  });

  it("keeps the project's out when the daemon passes the folder but Pi's store does not trust it", async () => {
    const result = await profiles(true).list(testCaller(), "s1");
    expect(result.profiles.map((p) => p.name)).toEqual(["scout"]);
  });
});
