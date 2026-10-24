import { z } from "zod";

/** The web origin of GitHub: the only one a link or a top-level navigation to GitHub may have. */
export const GITHUB_WEB_ORIGIN = "https://github.com";

export const GITHUB_LIMITS = Object.freeze({
  title: 512,
  body: 65_536,
  name: 256,
  list: 50,
  releases: 20,
  repositories: 100,
  checkLogBytes: 64 * 1024,
});

/** `owner/name` as GitHub spells it: no `..`, no slash beyond the one, no space. */
export const RepoFullName = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/)
  .refine((name) => !name.split("/")[1]?.match(/^\.{1,2}$/), "not a dot name");
export type RepoFullName = z.infer<typeof RepoFullName>;

export const ProjectGithub = z
  .object({ repository: RepoFullName, upstream: RepoFullName.nullable(), fork: z.boolean() })
  .strict();
export type ProjectGithub = z.infer<typeof ProjectGithub>;

const Text = (max: number) => z.string().max(max);
const Url = z.string().url().max(2048);
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const GithubStatusView = z
  .object({
    state: z.enum(["absent", "created", "connected", "reconnect"]),
    app: z
      .object({
        slug: Text(GITHUB_LIMITS.name),
        htmlUrl: Url,
        callbackOrigin: Url,
        originMatches: z.boolean(),
      })
      .strict()
      .nullable(),
    login: Text(GITHUB_LIMITS.name).nullable(),
    permissionMissing: z.boolean(),
  })
  .strict();
export type GithubStatusView = z.infer<typeof GithubStatusView>;

export const CheckView = z
  .object({
    id: Text(GITHUB_LIMITS.name),
    name: Text(GITHUB_LIMITS.title),
    state: z.enum(["success", "running", "failure", "neutral"]),
  })
  .strict();
export type CheckView = z.infer<typeof CheckView>;

export const PullView = z
  .object({
    number: Count,
    title: Text(GITHUB_LIMITS.title),
    url: Url,
    author: Text(GITHUB_LIMITS.name),
    draft: z.boolean(),
    headRef: Text(GITHUB_LIMITS.name),
    checks: z.array(CheckView).max(GITHUB_LIMITS.list),
  })
  .strict();
export type PullView = z.infer<typeof PullView>;

export const GithubIssueView = z
  .object({
    number: Count,
    title: Text(GITHUB_LIMITS.title),
    url: Url,
    author: Text(GITHUB_LIMITS.name),
    labels: z.array(Text(GITHUB_LIMITS.name)).max(GITHUB_LIMITS.list),
  })
  .strict();
export type GithubIssueView = z.infer<typeof GithubIssueView>;

export const ReleaseView = z
  .object({
    tag: Text(GITHUB_LIMITS.name),
    name: Text(GITHUB_LIMITS.title),
    publishedAt: Text(64).nullable(),
    url: Url,
    assets: z.array(z.object({ name: Text(GITHUB_LIMITS.name), url: Url }).strict()).max(GITHUB_LIMITS.list),
  })
  .strict();
export type ReleaseView = z.infer<typeof ReleaseView>;

export const ProjectGithubView = z
  .object({
    link: ProjectGithub.nullable(),
    key: z.enum(["absent", "added", "failed", "removing"]),
    clone: z
      .object({
        state: z.enum(["pending", "done", "failed"]),
        error: Text(GITHUB_LIMITS.title).nullable(),
      })
      .strict()
      .nullable(),
    pulls: z.array(PullView).max(GITHUB_LIMITS.list),
    issues: z.array(GithubIssueView).max(GITHUB_LIMITS.list),
    releases: z.array(ReleaseView).max(GITHUB_LIMITS.releases),
    fetchedAt: Text(64).nullable(),
  })
  .strict();
export type ProjectGithubView = z.infer<typeof ProjectGithubView>;
