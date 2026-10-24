import { describe, expect, it } from "vitest";
import { GITHUB_LIMITS, GithubIssueView, ProjectGithubView, PullView, RepoFullName } from "./github.ts";

describe("GitHub views", () => {
  it("RepoFullName refuses ../ and spaces", () => {
    for (const ok of ["octo/repo", "octo-cat/my.repo_1", "o/.github"])
      expect(RepoFullName.safeParse(ok).success, ok).toBe(true);
    for (const bad of [
      "../repo",
      "octo/..",
      "octo/.",
      "octo/re po",
      "oc to/repo",
      "octo/a/b",
      "octo",
      "octo/",
      "-/x y",
      "a".repeat(40) + "/r",
    ])
      expect(RepoFullName.safeParse(bad).success, bad).toBe(false);
  });

  it("views bound their text", () => {
    const pull = {
      number: 1,
      title: "t",
      url: "https://github.com/o/r/pull/1",
      author: "a",
      draft: false,
      headRef: "b",
      checks: [],
    };
    expect(PullView.safeParse(pull).success).toBe(true);
    expect(PullView.safeParse({ ...pull, title: "x".repeat(GITHUB_LIMITS.title + 1) }).success).toBe(false);
    expect(PullView.safeParse({ ...pull, extra: 1 }).success).toBe(false);
    expect(PullView.safeParse({ ...pull, checks: [{ id: "1", name: "ci", state: "queued" }] }).success).toBe(
      false,
    );
    const issue = { number: 2, title: "t", url: "https://github.com/o/r/issues/2", author: "a", labels: [] };
    expect(
      GithubIssueView.safeParse({ ...issue, labels: Array(GITHUB_LIMITS.list + 1).fill("x") }).success,
    ).toBe(false);
    const view = {
      link: null,
      key: "absent",
      clone: null,
      pulls: [],
      issues: [],
      releases: [],
      fetchedAt: null,
    };
    expect(ProjectGithubView.safeParse(view).success).toBe(true);
    expect(ProjectGithubView.safeParse({ ...view, key: "pending" }).success).toBe(false);
    expect(
      ProjectGithubView.safeParse({
        ...view,
        clone: { state: "failed", error: "x".repeat(GITHUB_LIMITS.title + 1) },
      }).success,
    ).toBe(false);
  });
});
