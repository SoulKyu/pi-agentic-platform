import { describe, expect, it } from "vitest";
import { FILTER_SCAN_ARGS } from "./exec.ts";
import { FILTERING_SUBCOMMANDS, guardFilters } from "./filters.ts";
import type { GitRunner } from "./runner.ts";

function bed() {
  const calls: string[][] = [];
  const raw: GitRunner = {
    async run(_root, args) {
      calls.push([...args]);
      return { stdout: Buffer.alloc(0), code: 0 };
    },
  };
  return { calls, runner: guardFilters(raw, { gitVersion: async () => "git version 2.53.0" }) };
}

describe("the filter guard and the lane subcommands (M9R13)", () => {
  it("lists status, diff and every subcommand that hashes or checks out working-tree files", () => {
    expect([...FILTERING_SUBCOMMANDS].sort()).toEqual(
      ["add", "commit", "diff", "restore", "reset", "status", "worktree", "write-tree"].sort(),
    );
  });

  it.each(["add", "commit", "restore", "reset", "worktree", "write-tree"])(
    "scans before %s",
    async (subcommand) => {
      const { calls, runner } = bed();
      await runner.run("/r", [subcommand, "x"]);
      expect(calls).toEqual([[...FILTER_SCAN_ARGS], [subcommand, "x"]]);
    },
  );

  it.each(["rev-parse", "branch", "update-ref", "for-each-ref"])(
    "does not scan before %s",
    async (subcommand) => {
      const { calls, runner } = bed();
      await runner.run("/r", [subcommand]);
      expect(calls).toEqual([[subcommand]]);
    },
  );
});
