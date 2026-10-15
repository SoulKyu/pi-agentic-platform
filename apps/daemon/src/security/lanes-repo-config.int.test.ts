import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LaneView } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FORGE_URL } from "../modules/lanes/testing/outward-bed.ts";
import {
  type CheckpointBed,
  readyLane,
  startCheckpointBed,
} from "../modules/lanes/testing/checkpoint-int.ts";
import { ok, TIMEOUT } from "./testing/lanes-bed.ts";

// Spec C §8.1, M9: a repository's own configuration is untrusted input. Whatever it names to run or to send a push
// to, a lane's capture, restore, commit and push do not follow (MC13, M9R10, M9R14).
let bed: CheckpointBed;
let other: string;
beforeEach(async () => {
  bed = await startCheckpointBed();
  other = join(bed.repo.dir, "other.git");
  bed.repo.git(bed.repo.dir, "init", "-q", "--bare", "-b", "main", other);
}, TIMEOUT);
afterEach(() => bed.stop());

const main = (): string => bed.projectRoot;
const git = (...args: string[]): string => bed.repo.git(main(), ...args);
const branchesOf = (bare: string): string => bed.repo.git(bare, "branch", "--list").trim();
const push = (laneId: string) => bed.owner.call("lanes.push", { laneId });
const otherUrl = (): string => `file://${other}`;
const OTHER_FORGE_URL = "https://github.com/test/other.git";

/** The agent's turn wrote `a.txt`: the lane commits it, so there is something to push. */
async function commitA(lane: LaneView): Promise<void> {
  const committed = await bed.owner.call("lanes.commit", {
    laneId: lane.id,
    paths: ["a.txt"],
    message: "Add a",
  });
  expect(committed).toMatchObject({ ok: true, result: { ok: true } });
}

describe("a repository that plants programs and push targets in its own configuration", () => {
  it(
    "creates a lane, captures a run, restores, commits and pushes without running any of them, and refuses the push",
    async () => {
      writeFileSync(join(main(), ".gitattributes"), "*.txt filter=evil\n");
      git("add", ".gitattributes");
      git("commit", "-q", "-m", "attributes");
      const markers = {
        filter: bed.repo.plant("filter"),
        fsmonitor: bed.repo.plant("fsmonitor"),
        ssh: bed.repo.plant("ssh"),
        editor: bed.repo.plant("editor"),
        credential: bed.repo.plant("credential"),
        receivepack: bed.repo.plant("receivepack"),
      };
      for (const kind of ["clean", "smudge"]) git("config", `filter.evil.${kind}`, markers.filter.script);
      git("config", "core.fsmonitor", markers.fsmonitor.script);
      git("config", "core.sshCommand", markers.ssh.script);
      git("config", "core.editor", markers.editor.script);
      git("config", "credential.helper", markers.credential.script);
      git("config", `url.${otherUrl()}.pushInsteadOf`, FORGE_URL);
      git("config", "http.proxy", "http://127.0.0.1:9");
      git("config", "remote.origin.receivepack", markers.receivepack.script);

      // The controls: plain git does run the programs it can reach without a network.
      git("worktree", "add", "-q", join(bed.repo.dir, "control"), "-b", "control");
      expect(existsSync(markers.filter.marker), "control: plain git runs the smudge driver").toBe(true);
      git("status", "--porcelain");
      expect(existsSync(markers.fsmonitor.marker), "control: plain git runs the fsmonitor hook").toBe(true);
      try {
        git("commit", "--allow-empty");
      } catch {
        // The planted editor writes no message: the commit stops, and the editor has run.
      }
      expect(existsSync(markers.editor.marker), "control: plain git runs the editor").toBe(true);
      git("worktree", "remove", "--force", join(bed.repo.dir, "control"));
      for (const { marker } of Object.values(markers)) writeFileSync(marker, "");
      for (const { marker } of Object.values(markers)) expect(readFileSync(marker, "utf8")).toBe("");

      const lane = await readyLane(bed);
      // Untouched so far: created, and the run's captures taken, with the planted settings in place.
      writeFileSync(join(lane.worktree, "a.txt"), "owner edit\n");
      const restored = await bed.owner.call("lanes.restore", {
        laneId: lane.id,
        sessionId: lane.primarySessionId as string,
      });
      expect(restored).toMatchObject({ ok: true, result: { ok: true, changed: true } });
      expect(readFileSync(join(lane.worktree, "a.txt"), "utf8")).toBe("v1\n");
      await commitA(lane);
      expect(await push(lane.id)).toMatchObject({ ok: true, result: { ok: false, reason: "repo_config" } });

      for (const [name, { marker }] of Object.entries(markers))
        expect([name, readFileSync(marker, "utf8")]).toEqual([name, ""]);
      expect(branchesOf(bed.bare)).toBe("");
      expect(branchesOf(other)).toBe("");
    },
    TIMEOUT,
  );

  it(
    "refuses the push for each key that names a program or a place, and pushes once they are gone",
    async () => {
      const lane = await readyLane(bed);
      await commitA(lane);
      const { script, marker } = bed.repo.plant("push-keys");
      const plants: Array<[string, string[], string[]]> = [
        ["core.sshCommand", ["config", "core.sshCommand", script], ["config", "--unset", "core.sshCommand"]],
        [
          "credential.helper",
          ["config", "credential.helper", script],
          ["config", "--unset", "credential.helper"],
        ],
        [
          "url.*.pushInsteadOf",
          ["config", `url.${otherUrl()}.pushInsteadOf`, FORGE_URL],
          ["config", "--unset", `url.${otherUrl()}.pushInsteadOf`],
        ],
        ["http.proxy", ["config", "http.proxy", "http://127.0.0.1:9"], ["config", "--unset", "http.proxy"]],
        [
          "remote.origin.receivepack",
          ["config", "remote.origin.receivepack", script],
          ["config", "--unset", "remote.origin.receivepack"],
        ],
      ];
      for (const [name, plant, unplant] of plants) {
        git(...plant);
        expect([name, await push(lane.id)]).toMatchObject([
          name,
          { ok: true, result: { ok: false, reason: "repo_config" } },
        ]);
        expect([name, branchesOf(bed.bare), branchesOf(other)]).toEqual([name, "", ""]);
        git(...unplant);
      }
      expect(existsSync(marker)).toBe(false);
      expect(await push(lane.id)).toMatchObject({ ok: true, result: { ok: true } });
      expect(branchesOf(bed.bare)).toContain(lane.branch);
      expect(branchesOf(other)).toBe("");
    },
    TIMEOUT,
  );

  // The test seam (`PAP_TEST_GIT_PROTOCOLS=file`) accepts any local push URL, so the other repository is named by its
  // forge URL here: production refuses a `file:` transport outright (`unsupported_remote`, push-lane.test.ts).
  it(
    "refuses a pushurl of another repository and a second url, and neither repository receives the branch",
    async () => {
      const lane = await readyLane(bed);
      await commitA(lane);
      const plants: Array<[string, string[], string[]]> = [
        [
          "a pushurl",
          ["config", "remote.origin.pushurl", OTHER_FORGE_URL],
          ["config", "--unset", "remote.origin.pushurl"],
        ],
        [
          "a second url",
          ["config", "--add", "remote.origin.url", OTHER_FORGE_URL],
          ["config", "--replace-all", "remote.origin.url", FORGE_URL],
        ],
      ];
      for (const [name, plant, unplant] of plants) {
        git(...plant);
        expect([name, await push(lane.id)]).toMatchObject([
          name,
          { ok: true, result: { ok: false, reason: "repo_config" } },
        ]);
        expect([name, branchesOf(bed.bare), branchesOf(other)]).toEqual([name, "", ""]);
        git(...unplant);
      }
      expect(await push(lane.id)).toMatchObject({ ok: true, result: { ok: true } });
      expect(branchesOf(bed.bare)).toContain(lane.branch);
      expect(branchesOf(other)).toBe("");
    },
    TIMEOUT,
  );

  it(
    "leaves another folder's files alone when the lane's config.worktree says core.worktree=<victim>",
    async () => {
      const lane = await readyLane(bed);
      const victim = join(bed.repo.dir, "victim");
      mkdirSync(victim);
      writeFileSync(join(victim, "a.txt"), "VICTIM\n");
      writeFileSync(join(victim, "precious.txt"), "PRECIOUS\n");
      git("config", "extensions.worktreeConfig", "true");
      bed.repo.git(lane.worktree, "config", "--worktree", "core.worktree", victim);
      // Control: the plant is in place, so plain git in the lane reads the victim's folder as its work tree.
      expect(bed.repo.git(lane.worktree, "rev-parse", "--show-toplevel").trim()).toBe(victim);

      writeFileSync(join(lane.worktree, "a.txt"), "owner edit\n");
      const restored = await bed.owner.call("lanes.restore", {
        laneId: lane.id,
        sessionId: lane.primarySessionId as string,
      });
      expect(restored).toMatchObject({ ok: true, result: { ok: true } });
      expect(readFileSync(join(lane.worktree, "a.txt"), "utf8")).toBe("v1\n");
      expect(readFileSync(join(victim, "a.txt"), "utf8")).toBe("VICTIM\n");
      expect(readFileSync(join(victim, "precious.txt"), "utf8")).toBe("PRECIOUS\n");
      const status = await ok<{ ok: boolean }>(bed.owner, "lanes.refresh", { laneId: lane.id });
      expect(status.ok).toBe(true);
    },
    TIMEOUT,
  );
});
