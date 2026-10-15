import { describe, expect, it } from "vitest";
import { issueUrl, parseIssueUrl } from "./issue-url.ts";

// The vectors of the daemon's `parseIssueUrl` test (kernel/forge/remote.test.ts): the same rule on both sides.
describe("parseIssueUrl (the web's copy of the daemon's rule)", () => {
  it.each([
    [
      "https://github.com/guix/infra/issues/412",
      { host: "github.com", path: "guix/infra", number: 412, kind: "github" },
    ],
    ["https://gitlab.com/g/s/p/-/issues/7", { host: "gitlab.com", path: "g/s/p", number: 7, kind: "gitlab" }],
    ["https://codeberg.org/o/r/issues/3", { host: "codeberg.org", path: "o/r", number: 3, kind: "gitea" }],
    ["  https://github.com/o/r/issues/1/  ", { host: "github.com", path: "o/r", number: 1, kind: "github" }],
  ])("%s", (url, issue) => {
    expect(parseIssueUrl(url)).toEqual(issue);
  });

  it("a known host keeps its kind whatever the override says", () => {
    expect(parseIssueUrl("https://github.com/o/r/issues/1", "gitlab")).toMatchObject({ kind: "github" });
  });

  it("an unknown host takes the override, or the gitlab form", () => {
    expect(parseIssueUrl("https://git.corp/o/r/issues/5", "gitea")).toMatchObject({ kind: "gitea" });
    expect(parseIssueUrl("https://git.corp/o/r/-/issues/5")).toMatchObject({ kind: "gitlab" });
  });

  it.each([
    "https://github.com/o/r/pull/3",
    "https://github.com/o/r/issues/0",
    "https://github.com/o/r/issues/12x",
    "https://github.com/o/r/issues/12345678901",
    "https://user:pw@github.com/o/r/issues/1",
    "http://github.com/o/r/issues/1",
    "https://github.com:8443/o/r/issues/1",
    "https://git.corp/o/r/issues/5",
    "https://gitlab.com/o/r/issues/1",
    "https://github.com/o/r/-/issues/1",
    "https://linear.app/team/issue/ABC-1",
    "https://github.com/issues/1",
    "https://github.com/../r/issues/1",
    "not a url",
    "fix the cache https://github.com/o/r/issues/1",
  ])("refuses %j", (url) => {
    expect(parseIssueUrl(url)).toBeNull();
  });

  it("rebuilds the canonical URL without query or fragment", () => {
    const issue = parseIssueUrl("https://github.com/o/r/issues/9?x=1#frag");
    expect(issue && issueUrl(issue)).toBe("https://github.com/o/r/issues/9");
    const lab = parseIssueUrl("https://gitlab.com/g/p/-/issues/2?a=b");
    expect(lab && issueUrl(lab)).toBe("https://gitlab.com/g/p/-/issues/2");
  });
});
