import type { GithubStatusView, ProjectGithubView } from "@pap/contracts";

/** What `github.status` answers. */
export const githubStatus = (patch: Partial<GithubStatusView> = {}): GithubStatusView => ({
  state: "connected",
  app: {
    slug: "pap-host-ab12",
    htmlUrl: "https://github.com/apps/pap-host-ab12",
    callbackOrigin: "http://localhost:3000",
    originMatches: true,
  },
  login: "octo",
  permissionMissing: false,
  ...patch,
});

/** What `projects.github` answers for a linked project with one failing pull request. */
export const githubView = (patch: Partial<ProjectGithubView> = {}): ProjectGithubView => ({
  link: { repository: "octo/notes", upstream: null, fork: false },
  key: "added",
  clone: { state: "done", error: null },
  pulls: [
    {
      number: 7,
      title: "Fix <b>the</b> build",
      url: "https://github.com/octo/notes/pull/7",
      author: "hubot",
      draft: false,
      headRef: "fix-build",
      checks: [
        { id: "c1", name: "lint", state: "success" },
        { id: "c2", name: "test <img src=x onerror=alert(1)>", state: "failure" },
      ],
    },
  ],
  issues: [
    {
      number: 12,
      title: "Crash on **start**",
      url: "https://github.com/octo/notes/issues/12",
      author: "mona",
      labels: ["bug"],
    },
  ],
  releases: [
    {
      tag: "v1.0.0",
      name: "First",
      publishedAt: "2026-10-01T10:00:00Z",
      url: "https://github.com/octo/notes/releases/tag/v1.0.0",
      assets: [
        { name: "notes.tgz", url: "https://github.com/octo/notes/releases/download/v1.0.0/notes.tgz" },
      ],
    },
  ],
  fetchedAt: "2026-10-24T10:00:00Z",
  ...patch,
});
