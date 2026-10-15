import { describe, expect, it } from "vitest";
import { prepare } from "./allowlist.ts";
import { FILTER_SCAN_ARGS } from "./exec.ts";

const split = (text: string): string[] => text.split(" ");

describe("prepare: the mechanics (M9R9)", () => {
  it("accepts the one config call there is, under the local profile only", () => {
    expect(prepare(FILTER_SCAN_ARGS, "local")).toEqual([...FILTER_SCAN_ARGS]);
    expect(prepare(FILTER_SCAN_ARGS, "remote")).toBeNull();
    expect(prepare(["config", "core.fsmonitor", "x"], "local")).toBeNull();
    expect(prepare(["config", "--get", "remote.origin.pushurl"], "local")).toBeNull();
  });

  it("refuses an unknown subcommand, an empty call and a prototype name", () => {
    for (const args of [[], ["gc"], ["constructor"], ["__proto__"], ["remote", "add", "x", "y"]])
      expect(prepare(args, "local"), args.join(" ")).toBeNull();
  });

  it("refuses a local subcommand under the remote profile", () => {
    expect(prepare(split("status --porcelain=v2"), "remote")).toBeNull();
    expect(prepare(split("rev-parse --show-toplevel"), "remote")).toBeNull();
  });

  it("inserts --no-ext-diff --no-textconv after diff, log and show", () => {
    expect(prepare(split("diff --numstat HEAD --"), "local")).toEqual([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--numstat",
      "HEAD",
      "--",
    ]);
    expect(prepare(["log"], "local")).toEqual(["log", "--no-ext-diff", "--no-textconv"]);
    expect(prepare(["show", "HEAD"], "local")).toEqual(["show", "--no-ext-diff", "--no-textconv", "HEAD"]);
  });

  it("keeps M8's free reads free (no shape)", () => {
    expect(
      prepare(split("status --porcelain=v2 -z --branch --ignore-submodules=dirty"), "local"),
    ).not.toBeNull();
    expect(prepare(split("ls-files -z --cached -- ./a ./b"), "local")).not.toBeNull();
    expect(prepare(split("cat-file blob HEAD:a.txt"), "local")).not.toBeNull();
    expect(prepare(["hash-object", "--stdin"], "local")).not.toBeNull();
    expect(prepare(split("check-ignore -z --stdin --no-index"), "local")).not.toBeNull();
    expect(prepare(split("check-ignore a"), "local")).toBeNull();
    expect(prepare(split("status --short"), "local")).toBeNull();
    expect(prepare(split("status -- -rf"), "local")).toBeNull();
    // After `--` nothing is an option, even an option the subcommand accepts before it.
    expect(prepare(split("status -- -z"), "local")).toBeNull();
  });

  it("refuses an option given twice, by name", () => {
    expect(prepare(split("status -z -z"), "local")).toBeNull();
    expect(prepare(split("ls-files --cached --cached"), "local")).toBeNull();
  });
});
