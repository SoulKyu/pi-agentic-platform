import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { LaneView } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { scriptHash } from "../modules/lanes/index.ts";
import { type OutwardBed, startOutwardBed } from "../modules/lanes/testing/outward-bed.ts";
import { createTerminal } from "../modules/terminal/testing/wire.ts";
import {
  approve,
  createLaneAs,
  ISSUE_URL,
  latest,
  ok,
  setupLog,
  TIMEOUT,
  writeProjectConfig,
} from "./testing/lanes-bed.ts";

// Spec C §8.1, M9: a lane script is the owner's approved text, run with the unattended environment, the daemon's
// starting umask and no terminal master (M9R27, M9R28, MC38, M9R119).
const STARTING_UMASK = 0o027;
const GH_ISSUE = JSON.stringify({
  number: 7,
  title: "Crash on start",
  body: "It dies.",
  state: "OPEN",
  labels: [],
  url: ISSUE_URL,
});
/** What the daemon's own environment holds in these tests; the script may see none of the first group. */
const SECRET_ENV: Record<string, string> = {
  SSH_AUTH_SOCK: "/run/leak/ssh-agent.sock",
  SSH_AGENT_PID: "4242",
  GH_TOKEN: "leak-gh-token",
  GITHUB_TOKEN: "leak-github-token",
  ANTHROPIC_API_KEY: "leak-anthropic-key",
  OPENAI_API_KEY: "leak-openai-key",
  GIT_PAP_LEAK: "leak-git",
  NODE_OPTIONS: "--no-warnings",
  PAP_LEAK_TEST: "leak-pap",
  BASH_ENV: "/nonexistent/leak-bash-env",
};
/** Names the allowlist keeps when the daemon has them, beside HOME, LANG and PATH. */
const KEPT_ENV: Record<string, string> = {
  TZ: "UTC",
  HTTPS_PROXY: "http://proxy.invalid:3128",
  XDG_CACHE_HOME: "/tmp/pap-xdg-cache",
};
/** What bash itself adds to `env`. */
const BASH_OWN = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);
const SCRIPT =
  "echo ---UMASK---; umask; echo ---ENV---; env; echo ---FDS---; ls -l /proc/self/fd; echo ---END---";

let bed: OutwardBed;
let previousUmask: number;
beforeAll(async () => {
  previousUmask = process.umask(STARTING_UMASK);
  bed = await startOutwardBed(
    [{ stdout: GH_ISSUE }],
    { SHELL: "/bin/sh", ...SECRET_ENV, ...KEPT_ENV },
    { steps: Array.from({ length: 4 }, () => ({ text: "hi" })), config: { maxWorkers: 8 } },
  );
}, TIMEOUT);
afterAll(async () => {
  await bed?.stop();
  process.umask(previousUmask);
});

const section = (log: string, name: string): string[] => {
  const text = log.split(`---${name}---\n`)[1] ?? "";
  return text.split("\n---")[0]?.split("\n").filter(Boolean) ?? [];
};
const activeLane = async (over: Record<string, unknown> = {}): Promise<LaneView> => {
  const [id] = await createLaneAs(bed.owner, bed, over);
  await vi.waitFor(() => expect(latest(bed, id as string)?.state).toBe("active"), { timeout: TIMEOUT });
  return latest(bed, id as string) as LaneView;
};
const setupState = (laneId: string): string | undefined => latest(bed, laneId)?.setup.state;
const masterFds = (): string[] =>
  readdirSync("/proc/self/fd").filter((fd) => {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`) === "/dev/ptmx";
    } catch {
      return false;
    }
  });

describe("an approved setup script", () => {
  it(
    "sees the unattended allowlist and the three lane variables, the starting umask and no terminal master",
    async () => {
      writeProjectConfig(bed, `setup: ${SCRIPT}\n`);
      await approve(bed, [{ kind: "setup", sha256: scriptHash(SCRIPT) }]);
      // A terminal is open in the daemon, so its PTY master is a descriptor the daemon holds when it spawns the script.
      await createTerminal(bed.owner, bed.projectRoot);
      expect(masterFds().length, "control: the daemon holds a PTY master").toBeGreaterThanOrEqual(1);

      const lane = await activeLane();
      await vi.waitFor(() => expect(setupState(lane.id)).toBe("ok"), { timeout: TIMEOUT });
      const log = await setupLog(bed, lane.id);
      expect(log).toContain("---END---");

      expect(section(log, "UMASK")).toEqual(["0027"]);

      const env = Object.fromEntries(
        section(log, "ENV")
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const)
          .filter(([name]) => !BASH_OWN.has(name)),
      );
      const expected = {
        HOME: join(bed.t.root, "user"),
        // The relative entries (`./node_modules/.bin`) of the daemon's PATH are dropped: a folder could plant a program.
        PATH: [bed.stub.binDir, ...(process.env.PATH ?? "").split(":")]
          .filter((entry) => entry.startsWith("/"))
          .join(":"),
        TERM: "dumb",
        ...KEPT_ENV,
        ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
        PAP_LANE_ID: lane.id,
        PAP_LANE_ROOT: bed.projectRoot,
        PAP_LANE_WORKTREE: lane.worktree,
      };
      expect(env).toEqual(expected);
      for (const name of Object.keys(SECRET_ENV)) expect(Object.keys(env)).not.toContain(name);
      for (const value of Object.values(SECRET_ENV)) expect(log).not.toContain(value);

      const targets = section(log, "FDS").flatMap((line) => /\d+ -> (.+)$/.exec(line)?.[1] ?? []);
      expect(targets.length).toBeGreaterThanOrEqual(3);
      expect(targets.filter((target) => target.includes("/dev/ptmx"))).toEqual([]);
    },
    TIMEOUT,
  );
});

describe("a setup script the owner did not approve", () => {
  it(
    "never runs: the lane says unapproved, and so does a click on Run setup",
    async () => {
      const text = "touch unapproved-marker";
      writeProjectConfig(bed, `setup: ${text}\n`);
      const lane = await activeLane({ title: "Unapproved" });
      await vi.waitFor(() => expect(setupState(lane.id)).toBe("unapproved"), { timeout: TIMEOUT });
      expect(existsSync(join(lane.worktree, "unapproved-marker"))).toBe(false);
      const clicked = await bed.owner.call("lanes.runScript", { laneId: lane.id, kind: "setup" });
      expect(clicked).toMatchObject({ ok: true, result: { ok: false, reason: "unapproved" } });
      expect(existsSync(join(lane.worktree, "unapproved-marker"))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "is not run once the file changed after the approval: unapproved again",
    async () => {
      const first = "touch first-marker";
      writeProjectConfig(bed, `setup: ${first}\n`);
      await approve(bed, [{ kind: "setup", sha256: scriptHash(first) }]);
      const lane = await activeLane({ title: "Changed file" });
      await vi.waitFor(() => expect(setupState(lane.id)).toBe("ok"), { timeout: TIMEOUT });
      expect(existsSync(join(lane.worktree, "first-marker"))).toBe(true);

      writeProjectConfig(bed, "setup: touch second-marker && echo changed\n");
      const clicked = await bed.owner.call("lanes.runScript", { laneId: lane.id, kind: "setup" });
      expect(clicked).toMatchObject({ ok: true, result: { ok: false, reason: "unapproved" } });
      await vi.waitFor(() => expect(setupState(lane.id)).toBe("unapproved"), { timeout: TIMEOUT });
      expect(existsSync(join(lane.worktree, "second-marker"))).toBe(false);
    },
    TIMEOUT,
  );
});

describe("Run setup in a lane whose session read an issue", () => {
  it(
    "answers tainted and runs nothing until the owner confirms",
    async () => {
      const text = "echo run >> runs.txt";
      writeProjectConfig(bed, `setup: ${text}\n`);
      await approve(bed, [{ kind: "setup", sha256: scriptHash(text) }]);
      const read = await ok<{ ok: boolean; issue: unknown }>(bed.owner, "lanes.issue", {
        projectRoot: bed.projectRoot,
        url: ISSUE_URL,
      });
      expect(read.ok).toBe(true);
      const lane = await activeLane({ title: "Fix crash", description: "", issue: read.issue });
      await vi.waitFor(() => expect(setupState(lane.id)).toBe("ok"), { timeout: TIMEOUT });
      await vi.waitFor(() => expect(latest(bed, lane.id)?.primarySessionId).toBeTruthy(), {
        timeout: TIMEOUT,
      });
      const runs = (): string[] =>
        readFileSync(join(lane.worktree, "runs.txt"), "utf8").split("\n").filter(Boolean);
      expect(runs()).toHaveLength(1);

      const refused = await bed.owner.call("lanes.runScript", { laneId: lane.id, kind: "setup" });
      expect(refused).toMatchObject({ ok: true, result: { ok: false, reason: "tainted" } });
      expect(setupState(lane.id)).toBe("ok");
      expect(runs()).toHaveLength(1);

      const confirmed = await bed.owner.call("lanes.runScript", {
        laneId: lane.id,
        kind: "setup",
        confirmTainted: true,
      });
      expect(confirmed).toMatchObject({ ok: true, result: { ok: true } });
      await vi.waitFor(() => expect(runs()).toHaveLength(2), { timeout: TIMEOUT });
    },
    TIMEOUT,
  );
});
