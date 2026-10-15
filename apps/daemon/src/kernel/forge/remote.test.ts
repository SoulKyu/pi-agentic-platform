import { describe, expect, it } from "vitest";
import { forgeOf, issueAllowed, issueUrl, parseIssueUrl, parseRemote } from "./remote.ts";

describe("parseRemote (M9R15)", () => {
  it.each([
    ["https://github.com/owner/repo.git", "github.com", "owner/repo"],
    ["https://user:tok@github.com/owner/repo", "github.com", "owner/repo"],
    ["git@github.com:owner/repo.git", "github.com", "owner/repo"],
    ["ssh://git@gitlab.example.com:2222/group/sub/proj.git", "gitlab.example.com", "group/sub/proj"],
    ["https://gitlab.com/a/b/c/", "gitlab.com", "a/b/c"],
    ["git+ssh://git@GitHub.com/owner/repo", "github.com", "owner/repo"],
  ])("%s", (url, host, path) => {
    expect(parseRemote(url)).toEqual({ host, path });
  });

  it.each([
    "file:///tmp/x",
    "/tmp/remote.git",
    "ext::sh -c evil",
    "https://github.com/owner",
    "https://github.com/../x/y",
    "git@github.com:owner/../../etc",
    "http://github.com/owner/repo",
    "https://github.com/owner/re po",
    "https://github.com/owner/repo\0x",
    "https://github.com/o/r/./x",
    `https://github.com/${"a/".repeat(9)}z`,
    `https://github.com/o/${"r".repeat(2100)}`,
    "fd::7/o/r",
    "https://github.com\\@evil.example/o/r",
    "https://github.com\\o\\r",
    "https://github.com/%2e%2e/x/y",
    "https://github.com/o/r?x=1",
    "https://github.com/o/r#f",
    "https://git%68ub.com/o/r",
    "https://github.com/o/r%41",
    "https://a@b@github.com/o/r",
    "a@b@github.com:o/r",
    "https://g\u0131thub.com/o/r",
  ])("refuses %j", (url) => {
    expect(parseRemote(url)).toBeNull();
  });
});

describe("forgeOf (M9-RT-04)", () => {
  it("the known public hosts win over a repository's forge line", () => {
    expect(forgeOf("github.com", "gitlab")).toBe("github");
    expect(forgeOf("gitlab.com", "github")).toBe("gitlab");
    expect(forgeOf("codeberg.org", undefined)).toBe("gitea");
    expect(forgeOf("gitea.com", "github")).toBe("gitea");
  });
  it("another host takes the override, else null", () => {
    expect(forgeOf("git.corp", "github")).toBe("github");
    expect(forgeOf("git.corp", undefined)).toBeNull();
    expect(forgeOf("constructor", undefined)).toBeNull();
  });
});

describe("parseIssueUrl (M9R15)", () => {
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
  ])("refuses %j", (url) => {
    expect(parseIssueUrl(url)).toBeNull();
  });
});

describe("issueAllowed (M9-RT-04)", () => {
  const github = { host: "github.com", path: "o/r", number: 1, kind: "github" } as const;
  const foreign = { host: "evil.example", path: "a/b", number: 1, kind: "gitlab" } as const;
  const none = { remote: null, forge: null };

  it("any repository on a public host of its own kind", () => {
    expect(issueAllowed(github, { remote: { host: "git.corp", path: "x/y" }, forge: "gitlab" })).toBe(true);
    expect(issueAllowed(github, none)).toBe(true);
    expect(issueAllowed({ ...github, kind: "gitlab" }, none)).toBe(false);
  });
  it("only github.com takes any repository: another public host must be the project's own (MC4 I2)", () => {
    const lab = { host: "gitlab.com", path: "other/repo", number: 1, kind: "gitlab" } as const;
    const onLab = { remote: { host: "gitlab.com", path: "mine/repo" }, forge: "gitlab" } as const;
    expect(issueAllowed(lab, onLab)).toBe(true);
    expect(issueAllowed(lab, { remote: { host: "github.com", path: "o/r" }, forge: "github" })).toBe(false);
    expect(issueAllowed(lab, none)).toBe(false);
  });
  it("refuses a codeberg or gitea.com issue when the origin is on github.com", () => {
    const github = { remote: { host: "github.com", path: "o/r" }, forge: "github" } as const;
    for (const host of ["codeberg.org", "gitea.com"])
      expect(issueAllowed({ host, path: "a/b", number: 1, kind: "gitea" }, github)).toBe(false);
  });
  it("refuses a foreign host for a github.com project", () => {
    expect(issueAllowed(foreign, { remote: { host: "github.com", path: "o/r" }, forge: "github" })).toBe(
      false,
    );
  });
  it("accepts the project's own host with the project's forge kind", () => {
    const project = { remote: { host: "evil.example", path: "o/r" }, forge: "gitlab" } as const;
    expect(issueAllowed(foreign, project)).toBe(true);
    expect(issueAllowed(foreign, { ...project, forge: "github" })).toBe(false);
  });
  it("refuses another host, or a project without a remote", () => {
    expect(issueAllowed(foreign, { remote: { host: "other.example", path: "o/r" }, forge: "gitlab" })).toBe(
      false,
    );
    expect(issueAllowed(foreign, none)).toBe(false);
  });
});

describe("issueUrl (M9-RT-15)", () => {
  it("rebuilds the canonical URL without query or fragment", () => {
    const issue = parseIssueUrl("https://github.com/o/r/issues/9?x=1#frag");
    expect(issue && issueUrl(issue)).toBe("https://github.com/o/r/issues/9");
    const lab = parseIssueUrl("https://gitlab.com/g/p/-/issues/2?a=b");
    expect(lab && issueUrl(lab)).toBe("https://gitlab.com/g/p/-/issues/2");
  });
});
