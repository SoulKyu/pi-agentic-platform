import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LaneView } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type OutwardBed, startOutwardBed, writeFile } from "./testing/outward-bed.ts";

const TIMEOUT = 120_000;
let bed: OutwardBed;
beforeEach(async () => {
  bed = await startOutwardBed();
});
afterEach(() => bed.stop());

const bareBranches = (): string => bed.repo.git(bed.bare, "branch", "--list").trim();
const push = (laneId: string) => bed.owner.call("lanes.push", { laneId });

describe("lanes.commit and lanes.push over /ws, with real git and a local bare remote", () => {
  it(
    "commits the chosen file with the trailer, pushes to the target the scan validated, and writes the audit row",
    async () => {
      const lane = await bed.createLane();
      writeFile(lane.worktree, "z.txt", "z\n");
      writeFile(lane.worktree, "other.txt", "o\n");
      const committed = await bed.owner.call("lanes.commit", {
        laneId: lane.id,
        paths: ["z.txt"],
        message: "Add z",
      });
      expect(committed).toMatchObject({
        ok: true,
        result: { ok: true, oid: expect.stringMatching(/^[0-9a-f]{40}$/) },
      });
      expect(bed.repo.git(lane.worktree, "log", "-1", "--format=%B").trimEnd()).toBe(
        `Add z\n\nPap-Lane: ${lane.id}`,
      );
      expect(bed.repo.git(lane.worktree, "status", "--porcelain").trim()).toBe("?? other.txt");
      expect(bareBranches()).toBe("");

      const pushed = await push(lane.id);
      expect(pushed).toMatchObject({
        ok: true,
        result: { ok: true, remote: { host: "local", path: "remote.git" } },
      });
      expect(bareBranches()).toContain(lane.branch);
      expect(bed.repo.git(lane.worktree, "config", `branch.${lane.branch}.remote`).trim()).toBe("origin");
      expect(bed.repo.git(bed.bare, "log", "-1", "--format=%s", lane.branch).trim()).toBe("Add z");

      const audit = await bed.owner.call("audit.list", {});
      const rows = (audit as unknown as { result: { entries: Array<{ reason?: string; detail?: unknown }> } })
        .result.entries;
      const row = rows.find((entry) => JSON.stringify(entry).includes("lane_pushed"));
      expect(JSON.stringify(row)).toContain(lane.id);
      expect(JSON.stringify(row)).toContain("remote.git");

      // The lane's view shows where the button goes and the forge identity (as configured, before insteadOf).
      const view = bed.views(lane.id).at(-1) as LaneView;
      expect(view.forge).toBe("github");
      expect(view.remote).toEqual({ host: "github.com", path: "test/repo" });
    },
    TIMEOUT,
  );

  it(
    "refuses a planted repository setting before anything is pushed, and pushes once it is gone",
    async () => {
      const lane = await bed.createLane();
      writeFile(lane.worktree, "z.txt", "z\n");
      await bed.owner.call("lanes.commit", { laneId: lane.id, paths: ["z.txt"], message: "Add z" });
      const marker = bed.repo.plant("receivepack");
      const main = bed.repo.root;
      const git = (...args: string[]) => bed.repo.git(main, ...args);
      const other = "https://github.com/test/other.git";

      const plants: Array<[string, () => void, () => void]> = [
        [
          "a local credential.helper",
          () => git("config", "credential.helper", "store"),
          () => git("config", "--unset", "credential.helper"),
        ],
        [
          "a pushurl of another repository",
          () => git("config", "remote.origin.pushurl", other),
          () => git("config", "--unset", "remote.origin.pushurl"),
        ],
        [
          "a second url",
          () => git("config", "--add", "remote.origin.url", other),
          () => git("config", "--replace-all", "remote.origin.url", "https://github.com/test/repo.git"),
        ],
        [
          "a receivepack program",
          () => git("config", "remote.origin.receivepack", marker.script),
          () => git("config", "--unset", "remote.origin.receivepack"),
        ],
        [
          "a core.sshCommand",
          () => git("config", "core.sshCommand", marker.script),
          () => git("config", "--unset", "core.sshCommand"),
        ],
      ];
      for (const [name, plant, unplant] of plants) {
        plant();
        expect(await push(lane.id), name).toMatchObject({
          ok: true,
          result: { ok: false, reason: "repo_config" },
        });
        expect(bareBranches(), name).toBe("");
        unplant();
      }
      expect(existsSync(marker.marker)).toBe(false);

      expect(await push(lane.id)).toMatchObject({ ok: true, result: { ok: true } });
      expect(bareBranches()).toContain(lane.branch);
    },
    TIMEOUT,
  );

  it(
    "sees a pushurl that only the lane's own config.worktree holds (it reads from the lane, not the main checkout)",
    async () => {
      const lane = await bed.createLane();
      writeFile(lane.worktree, "z.txt", "z\n");
      await bed.owner.call("lanes.commit", { laneId: lane.id, paths: ["z.txt"], message: "Add z" });
      bed.repo.git(bed.repo.root, "config", "extensions.worktreeConfig", "true");
      bed.repo.git(
        lane.worktree,
        "config",
        "--worktree",
        "remote.origin.pushurl",
        "https://github.com/test/other.git",
      );
      // Control: from the main checkout the push URL is still the forge's own; only the lane's root sees the plant.
      expect(bed.repo.git(bed.repo.root, "remote", "get-url", "--push", "origin").trim()).toBe(
        "https://github.com/test/repo.git",
      );
      expect(bed.repo.git(lane.worktree, "remote", "get-url", "--push", "origin").trim()).toBe(
        "https://github.com/test/other.git",
      );
      expect(await push(lane.id)).toMatchObject({ ok: true, result: { ok: false, reason: "repo_config" } });
      expect(bareBranches()).toBe("");
    },
    TIMEOUT,
  );

  it(
    "answers rejected when the remote branch has moved, and nothing is forced",
    async () => {
      const lane = await bed.createLane();
      writeFile(lane.worktree, "z.txt", "z\n");
      await bed.owner.call("lanes.commit", { laneId: lane.id, paths: ["z.txt"], message: "Add z" });
      expect(await push(lane.id)).toMatchObject({ ok: true, result: { ok: true } });
      // Someone else moves the branch on the remote.
      const other = join(bed.repo.dir, "other-clone");
      bed.repo.git(bed.repo.dir, "clone", "-q", bed.bare, other);
      bed.repo.git(other, "checkout", "-q", lane.branch);
      writeFile(other, "theirs.txt", "t\n");
      bed.repo.git(other, "add", ".");
      bed.repo.git(other, "commit", "-q", "-m", "theirs");
      bed.repo.git(other, "push", "-q", "origin", lane.branch);
      writeFile(lane.worktree, "mine.txt", "m\n");
      await bed.owner.call("lanes.commit", { laneId: lane.id, paths: ["mine.txt"], message: "Mine" });
      expect(await push(lane.id)).toMatchObject({ ok: true, result: { ok: false, reason: "rejected" } });
      expect(bed.repo.git(bed.bare, "log", "-1", "--format=%s", lane.branch).trim()).toBe("theirs");
    },
    TIMEOUT,
  );

  it("answers not_found for another lane id and for a token, and refuses a commit of nothing", async () => {
    const lane = await bed.createLane();
    expect(await bed.owner.call("lanes.push", { laneId: "no-such-lane-0001" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(
      await bed.owner.call("lanes.commit", { laneId: lane.id, paths: ["a.txt"], message: "Nothing" }),
    ).toMatchObject({ ok: true, result: { ok: false, reason: "nothing_to_commit" } });
  });
});
