import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LaneView } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scriptHash } from "./project-config.ts";
import { type OutwardBed, startOutwardBed } from "./testing/outward-bed.ts";

const TIMEOUT = 60_000;
const TEST = "touch tested-marker";
const ISSUE_URL = "https://github.com/test/repo/issues/7";
const GH_ISSUE = JSON.stringify({
  number: 7,
  title: "Crash on start",
  body: "It dies.",
  state: "OPEN",
  labels: [],
  url: ISSUE_URL,
});
const STEPS = Array.from({ length: 12 }, () => ({ text: "hi" }));

let bed: OutwardBed;
afterEach(() => bed.stop());

async function start(): Promise<void> {
  bed = await startOutwardBed([{ stdout: GH_ISSUE }], {}, { steps: STEPS, config: { maxWorkers: 8 } });
  mkdirSync(join(bed.projectRoot, ".pi"), { recursive: true });
  writeFileSync(join(bed.projectRoot, ".pi", "project.yaml"), `test: ${TEST}\n`);
  const approved = await bed.owner.call("lanes.approveScripts", {
    projectRoot: bed.projectRoot,
    scripts: [{ kind: "test", sha256: scriptHash(TEST) }],
  });
  expect(approved).toMatchObject({ ok: true, result: { ok: true } });
}

const latest = (id: string): LaneView => bed.views(id).at(-1) as LaneView;
async function fanOut(over: Record<string, unknown> = {}): Promise<{ fanoutId: string; ids: string[] }> {
  const answer = await bed.owner.call("lanes.create", {
    projectRoot: bed.projectRoot,
    title: "Try it",
    description: "do it",
    models: [null, null],
    ...over,
  });
  if (!answer.ok) throw new Error(`lanes.create failed: ${answer.error.code}`);
  const { laneIds, fanoutId } = answer.result as { laneIds: string[]; fanoutId: string };
  return { fanoutId, ids: laneIds };
}
const firstRunsEnded = (ids: string[]) =>
  vi.waitFor(() => expect(ids.map((id) => latest(id)?.firstRunEndedAt)).not.toContain(null), {
    timeout: TIMEOUT,
  });
const marker = (id: string): boolean => existsSync(join(latest(id).worktree, "tested-marker"));

describe("fan-out over /ws with the scripted provider", () => {
  it(
    "runs each lane's approved test once after its first run, compares the lanes and closes the loser keeping its branch",
    async () => {
      await start();
      const { fanoutId, ids } = await fanOut();
      expect(ids).toHaveLength(2);
      await firstRunsEnded(ids);
      await vi.waitFor(() => expect(ids.map((id) => latest(id).tests.state)).toEqual(["passed", "passed"]), {
        timeout: TIMEOUT,
      });
      expect(ids.map(marker)).toEqual([true, true]);
      expect(ids.map((id) => latest(id).primarySessionId)).not.toContain(null);
      expect(new Set(ids.map((id) => latest(id).primarySessionId)).size).toBe(2);

      const compared = await bed.owner.call("lanes.compare", { fanoutId });
      if (!compared.ok) throw new Error(`lanes.compare failed: ${compared.error.code}`);
      const { columns } = compared.result as {
        columns: Array<{
          laneId: string;
          summary: string | null;
          durationMs: number | null;
          costUsd: number | null;
        }>;
      };
      expect(columns.map((column) => column.laneId)).toEqual(ids);
      for (const column of columns) {
        expect(column.summary).toContain("hi");
        expect(column.durationMs).not.toBeNull();
        // M10's runs port feeds the column (agreement 14); the scripted provider prices nothing, so it is 0, not null.
        expect(column.costUsd).toBe(0);
      }

      const [winner, loser] = ids as [string, string];
      const branch = latest(loser).branch;
      let closed: { archived: string[]; refused: unknown[] } | undefined;
      await vi.waitFor(
        async () => {
          const answer = await bed.owner.call("lanes.closeLosers", { fanoutId, winner });
          if (!answer.ok) throw new Error(`lanes.closeLosers failed: ${answer.error.code}`);
          closed = answer.result as typeof closed;
          expect(closed?.refused).toEqual([]);
        },
        { timeout: TIMEOUT },
      );
      expect(closed?.archived).toEqual([loser]);
      await vi.waitFor(() => expect(latest(loser).state).toBe("archived"), { timeout: TIMEOUT });
      expect(latest(winner).state).toBe("active");
      const branches = bed.repo.git(bed.projectRoot, "branch", "--format=%(refname:short)").split("\n");
      expect(branches).toContain(branch);
      expect(branches).toContain(latest(winner).branch);
      expect(existsSync(latest(loser).worktree)).toBe(false);
    },
    TIMEOUT * 2,
  );

  it(
    "runs no test in an issue group, while the same daemon runs it in a plain group",
    async () => {
      await start();
      const read = await bed.owner.call("lanes.issue", { projectRoot: bed.projectRoot, url: ISSUE_URL });
      if (!read.ok || !(read.result as { ok: boolean }).ok) throw new Error("lanes.issue failed");
      const issue = (read.result as { issue: unknown }).issue;
      const issueGroup = await fanOut({ description: "", issue });
      await firstRunsEnded(issueGroup.ids);
      // The control group, run after: once its markers are there, the issue group's decision was long made.
      const control = await fanOut({ title: "Control" });
      await firstRunsEnded(control.ids);
      await vi.waitFor(() => expect(control.ids.map(marker)).toEqual([true, true]), { timeout: TIMEOUT });
      expect(issueGroup.ids.map(marker)).toEqual([false, false]);
      expect(issueGroup.ids.map((id) => latest(id).tests.state)).toEqual(["none", "none"]);
      expect(issueGroup.ids.map((id) => latest(id).source.kind)).toEqual(["issue", "issue"]);
    },
    TIMEOUT * 2,
  );
});
