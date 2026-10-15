import type { LaneView } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type OutwardBed, startOutwardBed, writeFile } from "./testing/outward-bed.ts";

const TIMEOUT = 120_000;
let bed: OutwardBed;
afterEach(() => bed.stop());

const VIEW_JSON = JSON.stringify({
  number: 5,
  url: "https://github.com/test/repo/pull/5",
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  statusCheckRollup: [{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }],
});

describe("lanes.prCreate and lanes.prRefresh over /ws, with a stub gh", () => {
  it(
    "creates once with the exact argv, the body on stdin and no token, shows the badge, and caches the refresh",
    async () => {
      bed = await startOutwardBed(
        [{ stdout: "[]" }, { stdout: "https://github.com/test/repo/pull/5\n" }, { stdout: VIEW_JSON }],
        { GH_TOKEN: "ghp_secret", SSH_AUTH_SOCK: "/tmp/agent.sock" },
      );
      const lane = await bed.createLane();
      writeFile(lane.worktree, "z.txt", "z\n");
      await bed.owner.call("lanes.commit", { laneId: lane.id, paths: ["z.txt"], message: "Add z" });

      // Before the first push there is no upstream: the bar pushes first, and no CLI ran.
      const early = await bed.owner.call("lanes.prCreate", {
        laneId: lane.id,
        title: "Add z",
        body: "Body\nof it",
        draft: false,
      });
      expect(early).toMatchObject({ ok: true, result: { ok: false, reason: "not_pushed" } });
      expect(bed.stub.calls()).toEqual([]);

      expect(await bed.owner.call("lanes.push", { laneId: lane.id })).toMatchObject({
        ok: true,
        result: { ok: true },
      });
      const created = await bed.owner.call("lanes.prCreate", {
        laneId: lane.id,
        title: "Add z",
        body: "Body\nof it",
        draft: false,
      });
      expect(created).toMatchObject({
        ok: true,
        result: {
          ok: true,
          pr: {
            number: 5,
            url: "https://github.com/test/repo/pull/5",
            state: "open",
            conflicts: false,
            checks: { total: 2, passed: 1, failed: 0, pending: 1 },
          },
        },
      });

      const calls = bed.stub.calls();
      expect(calls.map((call) => call.argv.slice(0, 2).join(" "))).toEqual([
        "pr list",
        "pr create",
        "pr view",
      ]);
      // The identity is the URL as configured (before the owner's insteadOf made it a file URL).
      expect(calls[1]?.argv).toEqual([
        "pr",
        "create",
        "--repo=github.com/test/repo",
        `--head=${lane.branch}`,
        "--base=main",
        "--title=Add z",
        "--body-file=-",
      ]);
      expect(calls[1]?.stdin).toBe("Body\nof it");
      for (const call of calls) {
        expect(call.envKeys).not.toContain("GH_TOKEN");
        expect(call.envKeys).not.toContain("SSH_AUTH_SOCK");
        expect(call.envKeys.filter((key) => key.startsWith("PAP_"))).toEqual([]);
        expect(call.cwd).toContain("forge");
      }

      // The lane stream shows the badge and where the button goes.
      const view = bed.views(lane.id).at(-1) as LaneView;
      expect(view.pr).toMatchObject({ number: 5, state: "open" });
      expect(view.pushRemote).toEqual({ host: "local", path: "remote.git" });
      expect(view.forge).toBe("github");

      // Within 60 s the refresh answers from the cache: the stub is not called again.
      const refreshed = await bed.owner.call("lanes.prRefresh", { laneId: lane.id });
      expect(refreshed).toMatchObject({ ok: true, result: { pr: { number: 5, state: "open" } } });
      expect(bed.stub.calls()).toHaveLength(3);
    },
    TIMEOUT,
  );

  it(
    "reuses the open pull request of the branch: no second creation",
    async () => {
      const open = {
        number: 5,
        url: "https://github.com/test/repo/pull/5",
        state: "OPEN",
        isDraft: false,
        isCrossRepository: false,
      };
      bed = await startOutwardBed([{ stdout: JSON.stringify([open]) }, { stdout: VIEW_JSON }]);
      const lane = await bed.createLane();
      writeFile(lane.worktree, "z.txt", "z\n");
      await bed.owner.call("lanes.commit", { laneId: lane.id, paths: ["z.txt"], message: "Add z" });
      await bed.owner.call("lanes.push", { laneId: lane.id });
      const again = await bed.owner.call("lanes.prCreate", {
        laneId: lane.id,
        title: "T",
        body: "",
        draft: false,
      });
      expect(again).toMatchObject({ ok: true, result: { ok: true, pr: { number: 5 } } });
      expect(bed.stub.calls().map((call) => call.argv.slice(0, 2).join(" "))).toEqual(["pr list", "pr view"]);
    },
    TIMEOUT,
  );

  it(
    "finds the lane's own pull request behind seven newer fork pull requests of the same branch name",
    async () => {
      const own = {
        number: 5,
        url: "https://github.com/test/repo/pull/5",
        state: "OPEN",
        isDraft: false,
        isCrossRepository: false,
      };
      const forks = Array.from({ length: 7 }, (_, at) => ({
        ...own,
        number: 90 - at,
        isCrossRepository: true,
      }));
      bed = await startOutwardBed([{ stdout: JSON.stringify([...forks, own]) }]);
      const lane = await bed.createLane();
      writeFile(lane.worktree, "z.txt", "z\n");
      await bed.owner.call("lanes.commit", { laneId: lane.id, paths: ["z.txt"], message: "Add z" });
      await bed.owner.call("lanes.push", { laneId: lane.id });
      const refreshed = await bed.owner.call("lanes.prRefresh", { laneId: lane.id });
      expect(refreshed).toMatchObject({ ok: true, result: { pr: { number: 5, state: "open" } } });
      const [call] = bed.stub.calls();
      expect(call?.argv).toContain("--limit=100");
      expect(call?.argv).toContain(`--head=${lane.branch}`);
    },
    TIMEOUT,
  );
});
