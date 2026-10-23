import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CheckpointBed, readyLane, startCheckpointBed, TIMEOUT } from "./testing/checkpoint-int.ts";

let bed: CheckpointBed;
beforeEach(async () => {
  bed = await startCheckpointBed();
});
afterEach(() => bed.stop());

const ended = (): number => bed.captures().filter((line) => line.startsWith("end after")).length;
const warnings = (): string[] =>
  bed.lines.flatMap((line) =>
    (line.level === "warn" || line.level === "error") &&
    line.msg !== "test_provider_enabled" &&
    line.msg !== "agent_vm_bridge_unavailable"
      ? [String(line.msg)]
      : [],
  );

describe("checkpoint captures around real runs (M9R73)", () => {
  it(
    "two sessions of one lane prompted back to back: both runs end, every capture is bracketed one at a time, the real index is untouched",
    async () => {
      const lane = await readyLane(bed);
      const second = await bed.owner.call("lanes.newSession", { laneId: lane.id });
      const secondId = (second as unknown as { result: { sessionId: string } }).result.sessionId;
      const before = ended();
      await Promise.all([
        bed.prompt(lane.primarySessionId as string, "again"),
        bed.prompt(secondId, "and again"),
      ]);
      await vi.waitFor(() => expect(ended()).toBe(before + 2), { timeout: 60_000 });
      // Strictly start, end, start, end: no capture began before the previous one ended.
      expect(bed.captures().join(",")).toMatch(/^(start (before|after),end (before|after),?)+$/);
      expect(bed.refs().filter((ref) => ref.includes("/e/")).length).toBeGreaterThanOrEqual(2);
      expect(warnings()).toEqual([]);
      // The agent's edits are unstaged and the real index holds nothing from the captures.
      expect(bed.repo.git(lane.worktree, "status", "--porcelain").trim()).toMatch(/^M a\.txt$|^ M a\.txt$/);
      expect(bed.repo.git(lane.worktree, "diff", "--cached", "--name-only").trim()).toBe("");
      expect(readdirSync(join(bed.t.home, "tmp", "git-index"))).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "two prompts sent at once to one idle session make one 'before' capture",
    async () => {
      const lane = await readyLane(bed);
      const sessionId = lane.primarySessionId as string;
      const before = bed.captures().filter((line) => line === "start before").length;
      await Promise.all([bed.prompt(sessionId, "one"), bed.prompt(sessionId, "two")]);
      await vi.waitFor(() => expect(ended()).toBeGreaterThanOrEqual(2), { timeout: 60_000 });
      expect(bed.captures().filter((line) => line === "start before").length - before).toBe(1);
    },
    TIMEOUT,
  );

  it(
    "a push held open does not hold a prompt: e/<leaf> is written before the run, with a hand edit in it",
    async () => {
      const lane = await readyLane(bed);
      const sessionId = lane.primarySessionId as string;
      const started = join(bed.repo.dir, "push-started");
      const release = join(bed.repo.dir, "push-release");
      const hook = join(bed.bare, "hooks", "pre-receive");
      writeFileSync(
        hook,
        // Bounded: gone after about 60 s, or as soon as the test folder is removed, so no orphan push can outlive the run.
        `#!/bin/sh\ntouch "${started}"\ni=0\nwhile [ ! -f "${release}" ] && [ -d "${dirname(release)}" ] && [ "$i" -lt 600 ]; do sleep 0.1; i=$((i+1)); done\n`,
        {
          mode: 0o755,
        },
      );
      try {
        const committed = await bed.owner.call("lanes.commit", {
          laneId: lane.id,
          paths: ["a.txt"],
          message: "turn 1",
        });
        expect(committed).toMatchObject({ ok: true, result: { ok: true } });
        let pushed: unknown = null;
        const pushing = bed.owner.call("lanes.push", { laneId: lane.id }, 90_000).then((answer) => {
          pushed = answer;
        });
        await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 30_000 });

        writeFileSync(join(lane.worktree, "hand.txt"), "by hand\n");
        const refsBefore = bed.repo.git(bed.projectRoot, "for-each-ref", "refs/pap/checkpoints");
        await bed.prompt(sessionId, "again");
        await vi.waitFor(() => expect(ended()).toBeGreaterThanOrEqual(2), { timeout: 60_000 });
        // The run is over, the push is still held, and the 'before' capture of the run held the hand edit.
        expect(pushed).toBeNull();
        expect(bed.repo.git(bed.projectRoot, "for-each-ref", "refs/pap/checkpoints")).not.toBe(refsBefore);
        const refs = bed.repo.git(
          bed.projectRoot,
          "for-each-ref",
          "--format=%(refname)",
          "refs/pap/checkpoints",
        );
        const before = refs
          .split("\n")
          .filter((ref) => ref.includes("/e/"))
          .map((ref) => bed.repo.git(bed.projectRoot, "ls-tree", "--name-only", ref))
          .filter((tree) => tree.includes("hand.txt"));
        expect(before.length).toBeGreaterThanOrEqual(1);
        writeFileSync(release, "");
        await pushing;
        expect(pushed).toMatchObject({ ok: true, result: { ok: true } });
      } finally {
        // Whatever threw above, the held push is let go before the folder is cleaned up.
        writeFileSync(release, "");
      }
    },
    TIMEOUT * 2,
  );
});
