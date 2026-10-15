import { describe, expect, it } from "vitest";
import { githubArgs } from "./github.ts";

const repo = { host: "github.com", path: "o/r" };

describe("githubArgs", () => {
  it("prCreate joins every value to its flag, even a hostile title", () => {
    expect(githubArgs.prCreate(repo, "pap/fix-1", "main", "-rf; $(touch x)", true)).toEqual([
      "pr",
      "create",
      "--repo=github.com/o/r",
      "--head=pap/fix-1",
      "--base=main",
      "--title=-rf; $(touch x)",
      "--body-file=-",
      "--draft",
    ]);
    expect(githubArgs.prCreate(repo, "a", "main", "t", false)).not.toContain("--draft");
  });
  it("prCreate sends no --base for a commit base: the forge takes its default branch", () => {
    const args = githubArgs.prCreate(repo, "pap/fix-1", undefined, "t", false);
    expect(args.some((arg) => arg.startsWith("--base"))).toBe(false);
    expect(args).toContain("--head=pap/fix-1");
  });
  it("prFind, prView and issueView are exact", () => {
    expect(githubArgs.prFind(repo, "pap/fix-1")).toEqual([
      "pr",
      "list",
      "--repo=github.com/o/r",
      "--head=pap/fix-1",
      "--state=all",
      "--json=number,url,state,isDraft,isCrossRepository",
      "--limit=100",
    ]);
    expect(githubArgs.prView(repo, 7)).toEqual([
      "pr",
      "view",
      "7",
      "--repo=github.com/o/r",
      "--json=number,url,state,isDraft,mergeable,statusCheckRollup",
    ]);
    expect(githubArgs.issueView({ host: "ghe.example.com", path: "o/r" }, 12)).toEqual([
      "issue",
      "view",
      "12",
      "--repo=ghe.example.com/o/r",
      "--json=number,title,body,state,labels,url",
    ]);
  });
  it("refuses before any spawn", () => {
    expect(() => githubArgs.prView({ host: "github.com", path: "o" }, 1)).toThrow("forge argument refused");
    expect(() => githubArgs.prView({ host: "github.com", path: "o/../r" }, 1)).toThrow(
      "forge argument refused",
    );
    expect(() => githubArgs.prView({ host: "github.com", path: "o/./r" }, 1)).toThrow(
      "forge argument refused",
    );
    expect(() => githubArgs.prFind(repo, "-b")).toThrow("forge argument refused");
    expect(() => githubArgs.prFind(repo, "a b")).toThrow("forge argument refused");
    expect(() => githubArgs.prCreate(repo, "a", "-x", "t", false)).toThrow("forge argument refused");
    expect(() => githubArgs.prView(repo, 0)).toThrow("forge argument refused");
    expect(() => githubArgs.issueView(repo, 1.5)).toThrow("forge argument refused");
  });
});
